# Versions and updates

**In the Web UI:** Open **Administration → Versions & updates** with Owner instance administration. The page shows the actual deployed product version, the latest GitHub stable release, and up to five prereleases from the twenty most recent releases. Each links to official notes. Semantic ordering makes `rc.10` newer than `rc.2`.

Newer versions still require compatibility and immutable artifact verification. Prereleases require an explicit exact version; they never replace the default stable target. Successful information is cached for fifteen minutes within a Worker isolate. **Check again** may reuse it. Failed or rate-limited checks show unavailable or expired information and check times, without blocking other features.

In **Ask your Agent to upgrade**, select an exact release and copy the prompt to your Agent. You can also keep **Check versions with my Agent first** to review available releases before selecting a target. The prompt includes this instance address and asks the Agent to review and confirm a local Skills/plugin update plan first, then review and confirm a separate instance upgrade plan.

The site cannot inspect local Skills, and copying does not apply either update. The Agent should verify `cfkanban --version`, the complete bundle and host installation locally, then read back the deployed version, health and original identity after an instance upgrade. See the [update workflows](../deployment/updates.md) for details.

```text
Use $cfkanban-admin to check this instance's deployed version and available stable and prerelease versions. Explain local Skills update and instance upgrade choices without applying either.
```

```sh
cfkanban admin updates show --json --no-interactive
```

The equivalent API is `GET /api/v1/admin/release-updates`. Project-only Owner sessions and scoped administrators cannot read it. The automatic announcement setting is described in [Instance upgrades](../deployment/updates.md).
