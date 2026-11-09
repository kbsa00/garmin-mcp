// Minimal login/consent page for the single owner.

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface LoginPageOptions {
	state?: string;
	clientName: string;
	redirectHost: string;
	error?: string;
	locked?: boolean;
	/** Form target; defaults to the MCP OAuth authorize endpoint. */
	action?: string;
	/** Overrides the default "is requesting read access…" sentence (plain text, escaped). */
	message?: string;
	button?: string;
}

export function renderLoginPage(o: LoginPageOptions): string {
	const message = o.message
		? escapeHtml(o.message)
		: `<strong>${escapeHtml(o.clientName)}</strong> (${escapeHtml(o.redirectHost)}) is requesting read access to your Garmin data.`;
	const form = o.locked
		? ""
		: `<form method="post" action="${escapeHtml(o.action ?? "/authorize")}">
  <input type="hidden" name="state" value="${escapeHtml(o.state ?? "")}">
  <label for="passphrase">Passphrase</label>
  <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">${escapeHtml(o.button ?? "Allow access")}</button>
</form>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Health connector login</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --fg:#1d1d1b; --muted:#6b6b66; --accent:#1f6feb; --err:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#222220; --fg:#ececea; --muted:#a3a39e; --accent:#4c8dff; --err:#ff7b72; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; padding:16px; box-sizing:border-box; }
  main { background:var(--card); max-width:400px; width:100%; padding:28px; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:var(--muted); margin:0 0 20px; }
  label { display:block; font-weight:600; margin-bottom:6px; }
  input[type=password] { width:100%; box-sizing:border-box; padding:10px 12px; font-size:16px; border:1px solid var(--muted); border-radius:8px; background:transparent; color:inherit; }
  button { margin-top:16px; width:100%; padding:11px; font-size:16px; font-weight:600; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
  .error { color:var(--err); font-weight:600; }
</style>
</head>
<body>
<main>
  <h1>Personal health connector</h1>
  <p>${message}</p>
  ${o.error ? `<p class="error" role="alert">${escapeHtml(o.error)}</p>` : ""}
  ${form}
</main>
</body>
</html>`;
}

