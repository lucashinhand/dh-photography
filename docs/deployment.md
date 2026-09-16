# Deployment and domain cutover

The first review checkpoint is the complete, tested PR. The live Pages checkpoint follows Lucas’s explicit merge approval. Never merge, attach a production domain or change DNS automatically. Lucas has confirmed that Squarespace will be retained in a dormant state; cancellation is not part of this workflow.

The temporary project address inherits the existing account-level `lucashahn.dev` Pages domain. No custom domain is attached to this repository. Actions-based Pages and the main-only environment policy were verified during implementation.

## Enable and deploy GitHub Pages

1. In repository **Settings → Pages → Build and deployment**, select **GitHub Actions**. The repository is public.
2. Confirm the `github-pages` environment permits deployments only from `main`.
3. Review the migration report, screenshots and passing checks on the implementation PR.
4. After Lucas approves, merge the PR. The workflow validates project and domain-root builds, uploads the official Pages artifact, and deploys only the main branch.
5. Check the deployment environment URL and open `https://lucashahn.dev/dh-photography/`.
6. Directly visit `/dh-photography/celebrity/`, `/dh-photography/about/` and `/dh-photography/contact/`; test mobile navigation, gallery images, lightbox and a missing URL. Confirm HTTPS and no Squarespace asset requests.

Manual **Actions → Validate and deploy portfolio → Run workflow** is supported. Selecting a non-main branch validates/builds but cannot deploy. PR workflows have no Pages write or OIDC permission. Encoding the photo library is not part of deployment.

## Approved production-domain cutover

Intended canonical domain: `https://davidhahnphotography.com.au`. Keep the temporary project deployment until it has passed the live checks above.

Before touching DNS, record the current zone and confirm who manages it. Preserve every existing MX, mail-related TXT (SPF/DKIM/DMARC), and unrelated record. Only change the website routing records listed below. Domain verification and routing are separate operations.

1. Lucas approves domain attachment and DNS cutover.
2. Verify ownership in GitHub account settings under **Pages**, using GitHub’s exact TXT challenge for `davidhahnphotography.com.au`. Keep that verification TXT record in place.
3. Set the repository Actions variable `PAGES_MODE` to `domain`, so the already-tested domain-root artifact is selected for deployment. The project build remains in the validation matrix.
4. Set the custom domain in repository **Settings → Pages** to `davidhahnphotography.com.au`. An Actions-based deployment is configured through Pages settings; a committed CNAME file is not required by this workflow.
5. Lucas updates apex A records to the current GitHub Pages addresses from the official guide, and `www` CNAME to `lucashinhand.github.io` (no repository suffix). Remove conflicting website A/AAAA/CNAME records, not mail records. Use IPv6 records only as documented by GitHub. Do not use wildcard DNS.
6. Run the main-branch deployment with `PAGES_MODE=domain`. Verify that canonical URLs, sitemap, navigation and assets use the domain-root configuration.
7. Wait for GitHub’s DNS check and certificate provisioning, then enable **Enforce HTTPS**. Check both apex and `www`, and verify the intended redirect to apex.
8. Check direct legacy routes, phone/email links and external links. Confirm email still sends and receives normally.
9. Record the successful cutover date and deployment SHA in the tracking issue. Retain the dormant Squarespace site.

DNS propagation and certificate issuance may take time. Consult the live official instructions immediately before cutover:

- [Configure a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [Verify a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages)
- [Secure Pages with HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)

## Rollback

For a site regression, revert the offending commit through a reviewed PR, merge only with approval, and let the main workflow redeploy. Record the last known-good SHA before cutover. A manual workflow on an older branch does not bypass the main-only deployment rule.

For domain trouble, retain the recorded original DNS values. Squarespace remains dormant; restoring it as a serving site would be a separate manual decision. Removing the GitHub custom domain and restoring `PAGES_MODE=project` requires a coordinated redeployment to restore the temporary project URL; preserve mail records throughout.
