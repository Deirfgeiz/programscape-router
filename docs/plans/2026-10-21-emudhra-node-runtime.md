# Patched Node runtime baseline

Dave authorized this security fix on October 21, 2026, with two independent
reviews per PR and merging reserved for him.

Use the checked-in .node-version/.nvmrc for local work. CI explicitly selects
22.23.4 or 24.22.1; package engine ranges exclude earlier vulnerable patches.
No application logic, credentials, provider settings, or user data changes.

After merge, verify the actual Node patch used by hosted builds and functions,
self-hosted runners, scheduled processes, MCP clients, and existing sandboxes.
Hosting providers may choose a major release from engines rather than enforce its
patch floor; inspect the running process.version before declaring remediation.
Rebuild/redeploy services and restart local tools. Changing engines is advisory
unless the package manager/host enforces it, and cannot update existing processes.
Keep production promotion under the existing owner-controlled release process.

Require ordinary HTTPS to succeed and all applicable compromised CA chains
to fail certificate validation, including cross-signs. DNS/timeouts are
inconclusive. Do not use insecure TLS switches to restore connectivity.
Use the incident's offline chains.zip where live endpoints are unavailable.
For rollback, retain a patched runtime even when reverting application code.

Sources:
- https://emudhra.we-have-a-problem.com/
- https://github.com/nodejs/node/releases/tag/v22.23.4
- https://github.com/nodejs/node/releases/tag/v24.22.1
