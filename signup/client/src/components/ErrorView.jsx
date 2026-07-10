import React from 'react';

export default function ErrorView({ error, onRetry }) {
  const code = (error && error.code) || 'ERROR';
  const message = (error && error.message) || 'Something went wrong.';
  const retryable = code !== 'NO_CAPACITY';

  return (
    <div className="error-view">
      <div className="banner error">{message}</div>
      {code === 'NO_NUMBERS' && (
        <p className="note">Tip: try the area code of a nearby major city.</p>
      )}
      {retryable && (
        <button type="button" onClick={onRetry}>Try again</button>
      )}
    </div>
  );
}
