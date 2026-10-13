# PJ-LARRY-fo-infomarchy

Fork personal de `nixfred/infomarchy`: plugin de Omarchy (QML + TypeScript) que convierte el fondo en un panel de agentes y uso. Los cambios propios entran por PR a `personal`. La rama `upstream` es un espejo que mantiene el workflow `sync-personal-fork` (ADR 0024 de `robert-flo/fleet`), que cada día rebasa `personal` sobre ella. Nunca push, PR ni issue al upstream.

## Agentes

- **PM: Sura**, el agente principal de `cursor-agent`. Convierte lo que pide Robert en issues `ready-for-agent`, lanza a `wk-fo-infomarchy` y a `rv-fo-infomarchy` como subagentes y sigue cada issue hasta su PR.
- **`wk-fo-infomarchy`** (`.cursor/agents/wk-fo-infomarchy.md`): toma un issue y lo lleva a un PR con prueba real.
- **`rv-fo-infomarchy`** (`.cursor/agents/rv-fo-infomarchy.md`): revisa el PR en solo lectura antes del merge.

## Agent skills

### Issue tracker

GitHub Issues via gh CLI. External PRs are not triaged. See docs/agents/issue-tracker.md.
Prefix issue titles with the issue number and a separator: <number> - <descriptive title>.

### Triage labels

Canonical five-role triage vocabulary (needs-triage, needs-info, ready-for-agent, ready-to-merge, wontfix). See docs/agents/triage-labels.md.

### Domain docs

Single-context repo layout (GLOSSARY.md + docs/adr/ at repo root). See docs/agents/domain.md.
