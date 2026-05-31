# Contributing to StatusFe

## Development Setup

```bash
git clone https://github.com/plorentec/statusfe.git
cd statusfe
npm install
cp .env.example .env
npm run dev
```

## Workflow

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/nombre`
3. Make changes
4. Commit with conventional commits (see below)
5. Push and open a PR

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add 2FA support
fix: resolve CSRF token issue
docs: update README with setup guide
chore: update dependencies
refactor: simplify session middleware
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`

## PR Guidelines

- One feature/fix per PR
- Describe what and why in the PR description
- Include screenshots for UI changes
- Test locally before submitting
- No breaking changes without migration notes

## Code Style

- No linter/formatter — keep it simple
- Consistent indentation (2 spaces)
- ES modules not required (CommonJS)
- No dependencies without checking existing ones first

## Reporting Issues

- Use GitHub Issues
- Include: steps to reproduce, expected behavior, environment (Docker/node version)
- Check existing issues before opening new ones
