import React from 'react';

const ICONS = {
  pending: '○',
  running: '◌',
  done: '✓',
  skipped: '—',
  failed: '✕'
};

export default function Progress({ job }) {
  const steps = (job && job.steps) || [];
  return (
    <div className="progress">
      <p className="intro">Setting up your environment — this takes about half a minute…</p>
      <ul className="steps">
        {steps.map((step) => (
          <li key={step.id} className={`step ${step.status}`}>
            <span className="icon">
              {step.status === 'running' ? <span className="spinner" /> : ICONS[step.status] || '○'}
            </span>
            <span className="label">{step.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
