const TYPES = [
  { value: 'inherit', label: 'Inherit from parent' },
  { value: 'none', label: 'No Auth' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'apikey', label: 'API Key' },
];

export default function AuthEditor({ auth = { type: 'inherit' }, onChange }) {
  const set = (patch) => onChange({ ...auth, ...patch });

  return (
    <div className="editor-section" style={{ overflowY: 'auto' }}>
      <div className="field-grid">
        <label>Type</label>
        <select className="select" value={auth.type || 'inherit'} onChange={(e) => set({ type: e.target.value })}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>

        {auth.type === 'bearer' && (
          <>
            <label>Token</label>
            <input
              className="text-input"
              value={auth.token ?? ''}
              placeholder="{{access_token}}"
              spellCheck={false}
              onChange={(e) => set({ token: e.target.value })}
            />
          </>
        )}

        {auth.type === 'basic' && (
          <>
            <label>Username</label>
            <input
              className="text-input"
              value={auth.username ?? ''}
              spellCheck={false}
              onChange={(e) => set({ username: e.target.value })}
            />
            <label>Password</label>
            <input
              className="text-input"
              type="password"
              value={auth.password ?? ''}
              onChange={(e) => set({ password: e.target.value })}
            />
          </>
        )}

        {auth.type === 'apikey' && (
          <>
            <label>Key</label>
            <input
              className="text-input"
              value={auth.key ?? ''}
              placeholder="X-API-Key"
              spellCheck={false}
              onChange={(e) => set({ key: e.target.value })}
            />
            <label>Value</label>
            <input
              className="text-input"
              value={auth.value ?? ''}
              spellCheck={false}
              onChange={(e) => set({ value: e.target.value })}
            />
            <label>Add to</label>
            <select className="select" value={auth.in || 'header'} onChange={(e) => set({ in: e.target.value })}>
              <option value="header">Header</option>
              <option value="query">Query Params</option>
            </select>
          </>
        )}
      </div>

      {(auth.type === 'none' || !auth.type || auth.type === 'inherit') && (
        <div className="empty-note">
          {auth.type === 'inherit'
            ? 'This request uses the authentication configured on its collection.'
            : 'This request does not send authentication credentials.'}
          <br />
          Values here accept <code className="mono">{'{{variables}}'}</code>.
        </div>
      )}
    </div>
  );
}
