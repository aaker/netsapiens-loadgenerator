import React, { useState } from 'react';

const FREE_MAIL = ['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com',
  'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'mail.com', 'gmx.com', 'zoho.com'];

// Client-side mirror of server validation for instant feedback; the server is authoritative.
function validate(form) {
  const errors = {};
  if (form.fullName.trim().length < 2) errors.fullName = 'Please enter your full name';
  if (form.companyName.trim().length < 2) errors.companyName = 'Please enter your company name';
  const email = form.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    errors.email = 'Please enter a valid email address';
  } else if (FREE_MAIL.includes(email.split('@')[1])) {
    errors.email = 'Please use your company email address';
  }
  if (!/^[2-9]\d{2}$/.test(form.areaCode.trim())) errors.areaCode = 'Enter a 3-digit US area code';
  if (!form.ack911) errors.ack911 = 'You must acknowledge this to continue';
  if (!form.ackNoSla) errors.ackNoSla = 'You must acknowledge this to continue';
  return errors;
}

export default function SignupForm({ onSubmit }) {
  const [form, setForm] = useState({ fullName: '', companyName: '', email: '', areaCode: '', ack911: false, ackNoSla: false });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  const setCheck = (field) => (e) => setForm({ ...form, [field]: e.target.checked });

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = validate(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setServerError(null);
    setSubmitting(true);
    try {
      await onSubmit(form);
    } catch (err) {
      if (err.field) setErrors({ [err.field]: err.message });
      else setServerError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <p className="intro">
        Sign up to get your own test environment, complete with a dedicated
        phone number in your area code.
      </p>

      <label>
        Full name
        <input type="text" value={form.fullName} onChange={set('fullName')} maxLength={64} autoComplete="name" />
        {errors.fullName && <span className="field-error">{errors.fullName}</span>}
      </label>

      <label>
        Company name
        <input type="text" value={form.companyName} onChange={set('companyName')} maxLength={64} autoComplete="organization" />
        {errors.companyName && <span className="field-error">{errors.companyName}</span>}
      </label>

      <label>
        Company email address
        <input type="email" value={form.email} onChange={set('email')} maxLength={128} autoComplete="email" />
        {errors.email && <span className="field-error">{errors.email}</span>}
      </label>

      <label>
        Preferred area code
        <input type="text" inputMode="numeric" placeholder="e.g. 480" value={form.areaCode} onChange={set('areaCode')} maxLength={3} />
        {errors.areaCode && <span className="field-error">{errors.areaCode}</span>}
      </label>

      <div className="acks">
        <label className="checkbox">
          <input type="checkbox" checked={form.ack911} onChange={setCheck('ack911')} />
          <span>
            I acknowledge that <strong>911 emergency services are NOT available</strong> on
            this system. Do not rely on it for emergency calling.
          </span>
        </label>
        {errors.ack911 && <span className="field-error">{errors.ack911}</span>}

        <label className="checkbox">
          <input type="checkbox" checked={form.ackNoSla} onChange={setCheck('ackNoSla')} />
          <span>
            I acknowledge that this system is for <strong>early testing only</strong> and
            is provided with <strong>NO SLA</strong> — service may be interrupted or reset
            at any time without notice.
          </span>
        </label>
        {errors.ackNoSla && <span className="field-error">{errors.ackNoSla}</span>}
      </div>

      {serverError && <div className="banner error">{serverError}</div>}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Submitting…' : 'Create my environment'}
      </button>
    </form>
  );
}
