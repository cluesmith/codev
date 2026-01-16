# Specification: Tower Theme Toggle

## Metadata
- **ID**: 0070
- **Status**: conceived
- **Created**: 2026-01-16
- **Protocol**: SPIDER

## Executive Summary

Add a light/dark mode toggle to the Agent Farm dashboard (tower).

## Problem Statement

The dashboard currently only has a dark theme. Some users prefer light mode, especially in bright environments.

## Goal

Add a theme toggle button that:
1. Switches between light and dark themes
2. Persists preference in localStorage
3. Respects system preference as default

## Scope

### In Scope
- Theme toggle button in dashboard header
- Light mode CSS variables
- localStorage persistence
- System preference detection

### Out of Scope
- Per-terminal theming
- Custom color themes beyond light/dark

## Success Criteria

1. Toggle button visible in dashboard header
2. Clicking toggles between light and dark
3. Preference persists across page reloads
4. System preference respected on first visit

## Technical Notes

- Dashboard is in `codev/templates/dashboard.html`
- Uses inline CSS currently
- Will need CSS variables for theming
