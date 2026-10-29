# Credential posture collector

Reconciles billable AI-provider secret names in Doppler with a metadata-only data-plane register and optional read-only provider checks.

```sh
python3 collector.py --config /path/to/config.json
python3 collector.py --config /path/to/config.json --stdout
```

`HUMANWARE_DATA_ROOT` is required. The canonical register defaults to `working/security/api-credential-audit/register.json`; generated output defaults to `generated/reports/security/credentials-current.json`.

Provider credentials are read only from environment variables named by `checks[].credentialEnv`. The instance must inject them through its secret executor. The collector never invokes Doppler for a secret value and never makes a billable model request.

Run tests with:

```sh
python3 services/observability/credential-posture/test_collector.py
```
