# Versions and updates

**In the Web UI:** Open **Administration → Versions & updates** with Owner instance administration. The page shows the actual deployed product version, the latest GitHub stable release, and up to five prereleases from the twenty most recent releases. Each links to official notes. Semantic ordering makes `rc.10` newer than `rc.2`.

Newer versions still require compatibility and immutable artifact verification. Prereleases require an explicit exact version; they never replace the default stable target. Successful information is cached for fifteen minutes within a Worker isolate. **Check again** may reuse it. Failed or rate-limited checks show unavailable or expired information and check times, without blocking other features.

The site cannot inspect local Skills. Run `cfkanban --version` locally and verify the complete bundle and host installation. **Update local Skills** and **Upgrade this instance** link to independent [update workflows](../deployment/updates.md). Checking does not update either.

```text
Use $cfkanban-admin to check this instance's deployed version and available stable and prerelease versions. Explain local Skills update and instance upgrade choices without applying either.
```

```sh
cfkanban admin updates show --json --no-interactive
```

The equivalent API is `GET /api/v1/admin/release-updates`. Project-only Owner sessions and scoped administrators cannot read it. The automatic announcement setting is described in [Instance upgrades](../deployment/updates.md).
