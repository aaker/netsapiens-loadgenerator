const express = require('express');
const { validateSignup } = require('./validate');
const { createRateLimiter } = require('./ratelimit');
const { createJob, getJob, publicView } = require('./jobs');
const { enqueue } = require('./provisioner');

const router = express.Router();

const rateLimit = createRateLimiter({
  perHour: parseInt(process.env.SIGNUP_RATE_LIMIT_PER_HOUR || '3', 10),
  globalPerDay: parseInt(process.env.SIGNUP_RATE_LIMIT_GLOBAL_PER_DAY || '20', 10)
});

router.post('/signup', rateLimit, (req, res) => {
  const { error, value } = validateSignup(req.body);
  if (error) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', field: error.field, message: error.message } });
  }
  const job = createJob(value, req.ip || req.socket.remoteAddress);
  enqueue(job);
  res.status(202).json({ jobId: job.id });
});

router.get('/signup/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown job' } });
  }
  res.json(publicView(job));
});

module.exports = router;
