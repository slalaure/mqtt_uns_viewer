# I3X Compliance Test Suite

This directory contains automated tests to validate RFC 001 compliance for I3X server implementations.

## Overview

The test suite verifies that an I3X server correctly implements the API specification defined in RFC 001. Tests are organized by category and marked as required or optional based on RFC compliance levels.

## Prerequisites

- Python 3.7+
- `requests` library
- `sseclient-py` library (for SSE/streaming tests)

Install dependencies:

```bash
pip install requests sseclient-py
```

## Running Tests

### Basic Usage

```bash
python test_runner.py --base-url http://localhost:8080
```

### Options

| Option | Description |
|--------|-------------|
| `--base-url URL` | Base URL of the I3X server (required) |
| `--category NAME` | Run only specific category: `exploratory`, `values`, `subscriptions` |
| `--required-only` | Run only tests marked as required |
| `--verbose` | Show detailed test output including request/response bodies |
| `--api-key KEY` | API key for authentication |
| `--timeout SECONDS` | Request timeout (default: 30) |

### Examples

Run all tests:
```bash
python test_runner.py --base-url http://localhost:8080
```

Run only required tests:
```bash
python test_runner.py --base-url http://localhost:8080 --required-only
```

Run exploratory tests only:
```bash
python test_runner.py --base-url http://localhost:8080 --category exploratory
```

Run with authentication:
```bash
python test_runner.py --base-url https://api.example.com --api-key sk_live_abc123
```

Verbose output:
```bash
python test_runner.py --base-url http://localhost:8080 --verbose
```

## Test Categories

### Exploratory (RFC 4.1.x) - Required

Tests for browsing the address space:

| Test File | Description |
|-----------|-------------|
| `test_namespaces.json` | Namespace listing and structure |
| `test_object_types.json` | Object type retrieval and filtering |
| `test_relationship_types.json` | Required relationship types exist |
| `test_instances.json` | Instance listing and filtering |

### Values (RFC 4.2.1-4.2.2) - Partially Required

Tests for value query and update operations:

| Test File | Required | Description |
|-----------|----------|-------------|
| `test_current_value.json` | Yes | LastKnownValue retrieval |
| `test_vqt_format.json` | Yes | VQT structure validation |
| `test_maxdepth.json` | Yes | Composition recursion behavior |
| `test_historical_value.json` | No | History queries |

### Subscriptions (RFC 4.2.3.x) - Optional

Tests for real-time data streaming:

| Test File | Description |
|-----------|-------------|
| `test_lifecycle.json` | Create/monitor/unsubscribe |
| `test_streaming.json` | SSE streaming behavior |
| `test_sync.json` | Sync/acknowledge behavior |

## Test File Format

Each test file is a JSON document with the following structure:

```json
{
  "id": "test-001",
  "name": "Human-readable test name",
  "description": "What this test verifies",
  "category": "exploratory",
  "required": true,
  "setup": [
    {
      "method": "POST",
      "path": "/subscriptions",
      "body": {},
      "save": {"subscriptionId": "$.subscriptionId"}
    }
  ],
  "request": {
    "method": "GET",
    "path": "/namespaces",
    "query": {"key": "value"},
    "headers": {"X-Custom": "value"},
    "body": {}
  },
  "assertions": [
    {"type": "status", "value": 200},
    {"type": "jsonPath", "path": "$", "isArray": true},
    {"type": "jsonPath", "path": "$[0].uri", "exists": true},
    {"type": "jsonPath", "path": "$[0].displayName", "type": "string"}
  ],
  "cleanup": [
    {
      "method": "DELETE",
      "path": "/subscriptions/${subscriptionId}"
    }
  ]
}
```

### Assertion Types

| Type | Properties | Description |
|------|------------|-------------|
| `status` | `value` | HTTP status code equals value |
| `jsonPath` | `path`, `exists` | Path exists in response |
| `jsonPath` | `path`, `value` | Path equals exact value |
| `jsonPath` | `path`, `valueType` | Path value is of type (string, number, boolean, array, object) |
| `jsonPath` | `path`, `isArray` | Path is an array |
| `jsonPath` | `path`, `minLength` | Array has minimum length |
| `jsonPath` | `path`, `contains` | Array contains value |
| `jsonPath` | `path`, `matches` | Value matches regex pattern |
| `header` | `name`, `exists` | Response header exists |
| `header` | `name`, `value` | Response header equals value |

### JSONPath Syntax

The test runner uses a simplified JSONPath syntax:

- `$` - Root object
- `$.field` - Access field
- `$[0]` - Array index
- `$[*].field` - All items' field (for array assertions)

## Compliance Levels

### Core (Required)

Pass all tests in:
- `exploratory/test_namespaces.json`
- `exploratory/test_object_types.json`
- `exploratory/test_relationship_types.json`
- `exploratory/test_instances.json`
- `values/test_current_value.json`
- `values/test_vqt_format.json`
- `values/test_maxdepth.json`

### Extended

Core plus:
- `values/test_historical_value.json`
- `subscriptions/test_lifecycle.json`
- `subscriptions/test_streaming.json` OR `subscriptions/test_sync.json`

### Full

Extended plus:
- All remaining optional tests

## Output Format

### Summary Output

```
I3X Compliance Test Results
===========================

Category: exploratory
  [PASS] test-ns-001: Get namespaces returns valid list
  [PASS] test-ns-002: Namespaces have required fields
  [FAIL] test-ns-003: Namespace URI is valid format
         Expected: uri to match ^https?://
         Actual: urn:example:namespace

Category: values
  [PASS] test-val-001: Get current value returns VQT
  [SKIP] test-val-002: Historical values (optional feature)

Summary:
  Total:  15
  Passed: 13
  Failed: 1
  Skipped: 1

Compliance Level: Core (required tests passed)
```

### Verbose Output

With `--verbose`, the runner also shows:
- Full request details (method, URL, headers, body)
- Full response details (status, headers, body)
- Assertion evaluation details

## Writing Custom Tests

### Adding a Test

1. Create or edit a JSON file in the appropriate category directory
2. Follow the test file format above
3. Use unique test IDs (e.g., `test-ns-004`)
4. Mark `required: true` for mandatory compliance tests

### Test Dependencies

For tests that depend on setup (like subscriptions):

```json
{
  "setup": [
    {
      "method": "POST",
      "path": "/subscriptions",
      "body": {},
      "save": {"subscriptionId": "$.subscriptionId"}
    }
  ],
  "request": {
    "method": "POST",
    "path": "/subscriptions/${subscriptionId}/register",
    "body": {"elementIds": ["sensor-001"]}
  },
  "cleanup": [
    {
      "method": "DELETE",
      "path": "/subscriptions/${subscriptionId}"
    }
  ]
}
```

The `save` object extracts values from setup responses for use in the main request via `${variable}` substitution.

## Troubleshooting

### Connection Refused

Ensure the server is running and the base URL is correct:
```bash
curl http://localhost:8080/namespaces
```

### Authentication Errors

If the server requires authentication, provide an API key:
```bash
python test_runner.py --base-url https://api.example.com --api-key YOUR_KEY
```

### Timeout Errors

Increase the timeout for slow servers:
```bash
python test_runner.py --base-url http://localhost:8080 --timeout 60
```

### SSE Tests Failing

SSE tests require the `sseclient-py` library:
```bash
pip install sseclient-py
```

## Contributing

To contribute new tests:

1. Create tests that validate specific RFC requirements
2. Include clear descriptions and assertions
3. Mark tests as required/optional appropriately
4. Test against the reference implementation
5. Submit a pull request

---

*Copyright (C) CESMII, the Smart Manufacturing Institute, 2024-2025. All Rights Reserved.*
