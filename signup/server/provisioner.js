// Provisioning orchestrator. All jobs are serialized through one in-process
// promise-chain queue — eliminates reseller/domain/TN races. Single Node
// process only (see README).
//
// Step order puts cheap-to-undo actions before money: releasing a reseller is
// a single PUT; a purchased TN has no automatic refund.

const ns = require('./nsclient');
const iq = require('./inteliquent');
const { tzOf } = require('./npa-data');
const { setStep, logEvent, finishJob, failJob } = require('./jobs');

// Must match the normalization the load generator used when creating the
// reseller pool (server.js:179): spaces, commas, apostrophes -> _, lowercased.
function slugify(description) {
  return String(description).replace(/\s/g, '_').replace(/,/g, '_').replace(/'/g, '_').toLowerCase();
}

// Restore a description that re-satisfies slugify(description) === name,
// returning the reseller to the available pool.
function descriptionFromName(name) {
  return name.split('_').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function formatTn(tn) {
  return `+1 (${tn.slice(0, 3)}) ${tn.slice(3, 6)}-${tn.slice(6)}`;
}

let queueTail = Promise.resolve();

function enqueue(job) {
  queueTail = queueTail
    .then(() => runJob(job))
    .catch(err => console.error(`Job ${job.id} escaped runJob:`, err));
}

async function releaseReseller(job, resellerName) {
  try {
    await ns.updateReseller(resellerName, descriptionFromName(resellerName));
    logEvent(job, 'compensated', { reseller: resellerName, action: 'released' });
  } catch (err) {
    logEvent(job, 'RESELLER_LEAKED', { reseller: resellerName, error: err.message });
    console.error(`RESELLER_LEAKED ${resellerName} (job ${job.id}): ${err.message}`);
  }
}

async function runJob(job) {
  const input = job.input;
  const domain = input.domain;
  let reseller = null;
  let tn = null;

  try {
    // 1. check-domain
    setStep(job, 'check-domain', 'running');
    let existingDomain;
    try {
      existingDomain = await ns.getDomain(domain);
    } catch (err) {
      setStep(job, 'check-domain', 'failed', { error: err.message });
      return failJob(job, 'NS_UNAVAILABLE', 'The phone system is temporarily unavailable. Please try again in a few minutes.');
    }
    const domainExists = !!existingDomain;
    setStep(job, 'check-domain', 'done', { domain, exists: domainExists });

    if (domainExists) {
      for (const id of ['claim-reseller', 'purchase-number', 'create-domain', 'add-phonenumber']) {
        setStep(job, id, 'skipped');
      }
    } else {
      // 2. claim-reseller
      setStep(job, 'claim-reseller', 'running');
      let available;
      try {
        const resellers = await ns.listResellers();
        available = resellers.filter(r => r.reseller && r.description && r.reseller === slugify(r.description));
      } catch (err) {
        setStep(job, 'claim-reseller', 'failed', { error: err.message });
        return failJob(job, 'NS_UNAVAILABLE', 'The phone system is temporarily unavailable. Please try again in a few minutes.');
      }
      if (!available.length) {
        setStep(job, 'claim-reseller', 'failed', { error: 'no available resellers' });
        return failJob(job, 'NO_CAPACITY', 'Beta capacity is full — please contact us to get access.');
      }
      const picked = available[Math.floor(Math.random() * available.length)];
      try {
        await ns.updateReseller(picked.reseller, input.companyName);
      } catch (err) {
        setStep(job, 'claim-reseller', 'failed', { reseller: picked.reseller, error: err.message });
        return failJob(job, 'PROVISION_FAILED', 'Account setup failed. Please try again.');
      }
      reseller = picked.reseller;
      setStep(job, 'claim-reseller', 'done', { reseller, description: input.companyName });

      // 3. purchase-number
      setStep(job, 'purchase-number', 'running');
      let purchase;
      try {
        purchase = await iq.purchaseNumberNear(input.areaCode, job.id);
      } catch (err) {
        setStep(job, 'purchase-number', 'failed', { error: err.message, data: err.data || null });
        await releaseReseller(job, reseller);
        if (err.code === 'NO_NUMBERS') {
          return failJob(job, 'NO_NUMBERS', `No phone numbers are available near area code ${input.areaCode}. Please try a different area code.`);
        }
        return failJob(job, 'PROVISION_FAILED', 'Phone number purchase failed. Please try again.');
      }
      tn = purchase.tn;
      if (purchase.dryRun) logEvent(job, 'dry_run', { tn });
      setStep(job, 'purchase-number', 'done', { tn, npaUsed: purchase.npaUsed, dryRun: !!purchase.dryRun });

      // 4. create-domain
      setStep(job, 'create-domain', 'running');
      try {
        await ns.createDomain({
          domain,
          description: input.companyName,
          reseller,
          'caller-id-name': input.companyName.substring(0, 15),
          'area-code': purchase.npaUsed,
          'caller-id-number': tn,
          'caller-id-number-emergency': tn,
          'time-zone': tzOf(purchase.npaUsed),
          'voicemail-enabled': 'yes',
          'domain-type': 'Standard',
          'dial-policy': 'US and Canada',
          'language-token': 'en_US',
          'recording-configuration': 'no'
        });
      } catch (err) {
        if (!ns.isConflict(err)) {
          setStep(job, 'create-domain', 'failed', { error: err.message, data: err.data || null });
          await releaseReseller(job, reseller);
          if (!purchase.dryRun) {
            logEvent(job, 'orphaned_tn', { tn, note: 'purchased but domain create failed — manual tnDisconnect needed' });
          }
          return failJob(job, 'PROVISION_FAILED', `Domain setup failed. Please contact us and quote job ID ${job.id}.`);
        }
      }
      setStep(job, 'create-domain', 'done', { domain, reseller });
    }

    // 5. create-user
    setStep(job, 'create-user', 'running');
    let extension = 1001;
    if (domainExists) {
      try {
        const users = await ns.listUsers(domain);
        extension = 1001 + users.length;
      } catch (err) {
        logEvent(job, 'warn', { note: 'listUsers failed, starting at 1001', error: err.message });
      }
    }
    let userCreated = false;
    for (let attempt = 0; attempt < 20 && !userCreated; attempt++, extension++) {
      try {
        await ns.createUser(domain, {
          domain,
          user: String(extension),
          'name-first-name': input.firstName,
          'name-last-name': input.lastName,
          email: input.email,
          // VERIFY: exact scope string against https://<TARGET_SERVER>/ns-api/docs
          'user-scope': 'Reseller'
        });
        userCreated = true;
      } catch (err) {
        if (ns.isConflict(err)) continue; // extension taken, try the next one
        setStep(job, 'create-user', 'failed', { extension, error: err.message, data: err.data || null });
        logEvent(job, 'recovery_needed', { domain, tn, reseller, note: 'domain (and TN) exist; resubmitting will retry user creation via the domain-exists path' });
        return failJob(job, 'USER_CREATE_FAILED', 'Your account could not be created. Please try again in a minute — your company domain is already set up.');
      }
    }
    if (!userCreated) {
      setStep(job, 'create-user', 'failed', { error: 'no free extension after 20 attempts' });
      logEvent(job, 'recovery_needed', { domain, note: 'extension exhaustion' });
      return failJob(job, 'USER_CREATE_FAILED', 'Your account could not be created. Please contact us.');
    }
    const user = String(extension - 1);
    setStep(job, 'create-user', 'done', { user, domain });

    // 6. send-welcome (non-fatal)
    setStep(job, 'send-welcome', 'running');
    let emailSent = false;
    try {
      await ns.sendWelcomeEmail(domain, user);
      emailSent = true;
      setStep(job, 'send-welcome', 'done');
    } catch (err) {
      setStep(job, 'send-welcome', 'failed', { error: err.message, data: err.data || null });
      logEvent(job, 'warn', { note: 'welcome email failed', domain, user });
    }

    // 7. add-phonenumber (fresh domains only, non-fatal)
    if (!domainExists) {
      setStep(job, 'add-phonenumber', 'running');
      try {
        await ns.addPhonenumber(domain, {
          domain,
          phonenumber: '1' + tn,
          'phone-number-description': `Signup - ${input.companyName}`,
          'dial-rule-application': 'available-number',
          'dial-rule-translation-destination-user': '*'
        });
        setStep(job, 'add-phonenumber', 'done', { phonenumber: '1' + tn });
      } catch (err) {
        if (ns.isConflict(err)) {
          setStep(job, 'add-phonenumber', 'done', { phonenumber: '1' + tn, note: 'already in inventory' });
        } else {
          setStep(job, 'add-phonenumber', 'failed', { error: err.message });
          logEvent(job, 'warn', { note: 'inventory add failed', tn });
        }
      }
    }

    finishJob(job, {
      domain,
      user,
      login: `${user}@${domain}`,
      phoneNumber: tn ? formatTn(tn) : null,
      emailSent
    });
  } catch (err) {
    // Unexpected escape hatch — compensate what we know about
    console.error(`Job ${job.id} unexpected error:`, err);
    logEvent(job, 'recovery_needed', { note: 'unexpected error', error: err.message, reseller, tn });
    if (reseller && job.steps.find(s => s.id === 'create-domain').status !== 'done') {
      await releaseReseller(job, reseller);
    }
    failJob(job, 'PROVISION_FAILED', `Something went wrong. Please contact us and quote job ID ${job.id}.`);
  }
}

module.exports = { enqueue };
