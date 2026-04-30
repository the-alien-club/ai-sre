# Playbook: Trivy Exposed Secret (always urgent)

Triggered when Trivy detects a secret (API key, token, credential) baked into a container image.
**This is always urgent regardless of the image's deployment status** — if the secret is real,
it may already be compromised.

1. Identify the image and what secret was found:
   - Note the rule ID and category (AWS, GitHub token, generic API key, etc.)
   - Note the file path inside the image where the secret was detected
2. Check if the image is currently deployed:
   ```bash
   kubectl --context <ctx> get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.containers[*].image}{"\n"}{end}' | grep "<image>"
   ```
3. Check git history for when the secret was introduced:
   ```bash
   cd ~/repos/<repo> && git log --all --source --oneline -S "<partial_secret_value>" -- <file_path>
   ```
4. **ALWAYS recommend immediate escalate** with:
   - What kind of secret was exposed
   - Whether the image is currently deployed (multiplies urgency if yes)
   - The file path in the image
   - The git commit that introduced it (if found)
   - **Two action items the CTO must do**:
     a. Rotate the secret if it's real (revoke + reissue)
     b. Rebuild the image without the secret (use Kubernetes Secrets / External Secrets instead)
5. NEVER auto-fix — secret rotation requires human judgment.
