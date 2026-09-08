#!/bin/sh
# Forge concept: issue-view (GitHub via gh CLI)
# Input: CODEV_ISSUE_ID
# Output: JSON {title, body, state, url, author, createdAt, assignees, labels, milestone, comments[]}
# author/createdAt/assignees/labels/milestone are optional by contract; `gh`
# emits them in the neutral shapes the IssueView contract expects (author.login,
# assignees[].login, labels[].name, milestone.title or null when unset).
exec gh issue view "$CODEV_ISSUE_ID" --json title,body,state,url,author,createdAt,assignees,labels,milestone,comments
