# pi-litellm-hub

Small, readable pi connector for one LiteLLM gateway: catalog thinking levels, Claude over `/v1/messages`, honest spend, and a status line that says why.

## Privacy hooks

Enable the local privacy scanner hooks for this checkout with:

```sh
git config core.hooksPath .githooks
```

The pre-commit hook scans staged additions; the pre-push hook scans commits in the refs being pushed. The denylist stays in the shared Git directory and is not part of the repository.
