import React from 'react';

export default function Success({ result }) {
  if (!result) return null;
  return (
    <div className="success">
      <div className="banner ok">Your environment is ready! 🎉</div>

      <dl className="details">
        <dt>Domain</dt>
        <dd>{result.domain}</dd>
        <dt>Login</dt>
        <dd>{result.login}</dd>
        {result.phoneNumber && (
          <>
            <dt>Phone number</dt>
            <dd>{result.phoneNumber}</dd>
          </>
        )}
      </dl>

      {result.domainExisted && (
        <p className="note">
          The domain <strong>{result.domain}</strong> already existed, so we
          added your user to it and skipped creating a new domain and phone
          number.
        </p>
      )}

      {result.emailSent ? (
        <p className="note">
          <strong>Check your email</strong> for a welcome message with a link to
          set your password and log in.
        </p>
      ) : (
        <p className="note warn">
          We couldn't send your welcome email automatically. Please contact us
          to get your password set up.
        </p>
      )}
    </div>
  );
}
