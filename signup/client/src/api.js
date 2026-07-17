// BASE_URL is Vite's `base` ('/signup/'), so API_BASE resolves to '/signup/api'.
const API_BASE = import.meta.env.BASE_URL + 'api';

export async function postSignup(form) {
  const res = await fetch(`${API_BASE}/signup`, {
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
  const res = await fetch(`${API_BASE}/signup/${jobId}`);
  if (!res.ok) throw new Error('Job not found');
  return res.json();
}
