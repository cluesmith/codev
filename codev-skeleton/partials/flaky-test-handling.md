2. **DO NOT** skip porch checks or use any workaround to avoid the failure
3. **DO** mark the test as skipped with a clear annotation (e.g., `it.skip('...') // FLAKY: skipped pending investigation`)
4. **DO** document each skipped flaky test under a "Flaky Tests" section in the artifact where your protocol records outcomes (review file, PR body, findings, or maintenance-run file)
5. Commit the skip and continue with your work