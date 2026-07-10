export async function postSignup(form) {
  const res = await fetch('/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(form)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error((data.error && data.error.message) || 'Signup failed'), {
      code: (data.error && data.error.code) || 'ERROR',
      field: data.error && data.error.field
    });
  }
  return data; // { jobId }
}

export async function getJob(jobId) {
  const res = await fetch(`/api/signup/${jobId}`);
  if (!res.ok) throw new Error('Job not found');
  return res.json();
}
