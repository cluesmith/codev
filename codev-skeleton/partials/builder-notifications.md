Always use `afx send architect "..."` to notify the architect at key moments:
- **Gate reached**: `afx send architect "Project {{project_id}}: <gate-name> ready for approval"`
- **PR ready**: `afx send architect "PR #N ready for review (project {{project_id}})"`
- **PR merged**: `afx send architect "Project {{project_id}} PR merged. Entering verify phase."`
- **Blocked**: `afx send architect "Blocked on project {{project_id}}: [reason]"`