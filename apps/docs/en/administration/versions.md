# Versions and updates

**In the Web UI:** Open **Administration → Versions & updates** with Owner instance administration. The page shows the deployed product version and the stable release selected by GitHub's public `releases/latest` redirect. It also shows up to five prereleases from the first public releases page, inspecting at most twenty cards. GitHub's Pre-release badge identifies the channel, and publication time determines the list order. Each links to official notes.

Newer versions still require compatibility and immutable artifact verification. Publication order does not determine whether a release upgrades the current version. Prereleases require an explicit exact version; they never replace the default stable target. Discovery reads public GitHub pages without a token or REST API request. Successful information is cached for fifteen minutes within a Worker isolate. **Check again** may reuse it. Webpage access limits or parsing changes show unavailable or expired information and check times, without blocking other features.

In **Ask your Agent to upgrade**, the default is **Latest stable release**. The other options are discovered prereleases with exact version numbers; none is selected automatically. Copy the one-sentence request to your Agent to use the `cfkanban-deploy` skill to update the local cfKanban plugin first, then this site's online deployment. The request includes your browser's current site origin and targets either the latest stable release or the selected exact prerelease version for the deployment upgrade. Refreshing away a selected prerelease or changing the Session resets the target to **Latest stable release**.

The site cannot inspect local Skills, and copying only produces text. Local plugin updates and Instance upgrades retain the skill's independent update and upgrade authorization requirements. See the [update workflows](../deployment/updates.md) for details.

```text
Use the cfkanban-deploy skill to update my local cfKanban plugin, then upgrade the deployment at <current-site-origin> to the latest stable release.
```

```sh
cfkanban admin updates show --json --no-interactive
```

The equivalent API is `GET /api/v1/admin/release-updates`. Project-only Owner sessions and scoped administrators cannot read it. The automatic announcement setting is described in [Instance upgrades](../deployment/updates.md).
