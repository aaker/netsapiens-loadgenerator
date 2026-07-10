import React, { useCallback, useEffect, useRef, useState } from 'react';
import SignupForm from './components/SignupForm.jsx';
import Progress from './components/Progress.jsx';
import Success from './components/Success.jsx';
import ErrorView from './components/ErrorView.jsx';
import { postSignup, getJob } from './api.js';

const POLL_MS = 1500;

export default function App() {
  const [view, setView] = useState('form'); // form | progress | success | error
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPolling = useCallback((jobId) => {
    stopPolling();
    sessionStorage.setItem('signupJobId', jobId);
    setView('progress');
    pollRef.current = setInterval(async () => {
      try {
        const data = await getJob(jobId);
        setJob(data);
        if (data.status === 'succeeded') {
          stopPolling();
          sessionStorage.removeItem('signupJobId');
          setView('success');
        } else if (data.status === 'failed') {
          stopPolling();
          sessionStorage.removeItem('signupJobId');
          setError(data.error || { code: 'ERROR', message: 'Signup failed' });
          setView('error');
        }
      } catch {
        stopPolling();
        sessionStorage.removeItem('signupJobId');
        setError({ code: 'ERROR', message: 'Lost connection to the signup service. Please try again.' });
        setView('error');
      }
    }, POLL_MS);
  }, []);

  // Resume an in-flight job after a page refresh
  useEffect(() => {
    const saved = sessionStorage.getItem('signupJobId');
    if (saved) startPolling(saved);
    return stopPolling;
  }, [startPolling]);

  const handleSubmit = async (form) => {
    setError(null);
    const { jobId } = await postSignup(form); // throws on 4xx; form displays it
    startPolling(jobId);
  };

  const reset = () => {
    stopPolling();
    sessionStorage.removeItem('signupJobId');
    setJob(null);
    setError(null);
    setView('form');
  };

  return (
    <div className="page">
      <div className="card">
        <h1>Beta Access Signup</h1>
        {view === 'form' && <SignupForm onSubmit={handleSubmit} />}
        {view === 'progress' && <Progress job={job} />}
        {view === 'success' && <Success result={job && job.result} />}
        {view === 'error' && <ErrorView error={error} onRetry={reset} />}
      </div>
    </div>
  );
}
