# Releasing

The maintainer's steps for a new version.

## 1. Prepare

1. Move the "Unreleased" entries in [CHANGELOG.md](CHANGELOG.md) under the new version.
2. Set the version: `npm version <x.y.z> --no-git-tag-version`.
3. Check everything:

   ```
   npm run lint && npm run typecheck && npm test && npm run test:integration
   npm run package && npm run package:check && npm run smoke:vsix
   ```

4. Commit the release as `chore(release): <x.y.z>`.

## 2. Tag

```
git tag v<x.y.z>
git push origin main v<x.y.z>
```

The **Release** workflow:

- checks that the tag matches `package.json`;
- runs lint, typecheck, the unit tests and packaging;
- creates a GitHub Release with the `.vsix` attached;
- publishes that `.vsix` to the Marketplace and Open VSX, each only when it is switched on (below).

## 3. Marketplace and Open VSX

Publishing is off until these repository variables are set to `true` (Settings → Secrets and variables → Actions → Variables):

| Variable              | Registry                       | Authentication                                       |
| --------------------- | ------------------------------ | ---------------------------------------------------- |
| `PUBLISH_MARKETPLACE` | Visual Studio Marketplace      | Trusted Publishing (OpenID Connect), no stored token |
| `PUBLISH_OPENVSX`     | Open VSX (VSCodium and others) | the `OVSX_PAT` repository secret                     |

**Marketplace, once:**

1. Create the publisher `celalakcelikk` on the [management page](https://marketplace.visualstudio.com/manage). The ID cannot be changed later.
2. In the publisher, open **Trusted Publishing**, choose **Create**, and enter:
   - repository owner `celalakcelikk`;
   - repository `magipilot`;
   - workflow `release.yml`;
   - no environment.
3. Set `PUBLISH_MARKETPLACE` to `true`.

**Open VSX, once:**

1. Sign in at [open-vsx.org](https://open-vsx.org) with GitHub, and sign the publisher agreement in your profile.
2. Create an access token, then the namespace: `npx ovsx create-namespace celalakcelikk -p <token>`.
3. Store the token as a secret: `gh secret set OVSX_PAT`. It asks for the value, so it is not left in your shell history.
4. Set `PUBLISH_OPENVSX` to `true`.

**Publishing a version that is already released** (for example, after switching a registry on):

```
gh workflow run release.yml --ref v<x.y.z>
```

- The run reuses the existing GitHub Release and its `.vsix`; it does not build again.
- A registry that already has the version skips it (`--skip-duplicate`), so the same command also retries a registry that failed.

Never commit a token.
