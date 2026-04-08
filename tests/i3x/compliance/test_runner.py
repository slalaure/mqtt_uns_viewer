#!/usr/bin/env python3
"""
I3X Compliance Test Runner

Validates RFC 001 compliance for I3X server implementations.

Usage:
    python test_runner.py --base-url http://localhost:8080
    python test_runner.py --base-url http://localhost:8080 --category exploratory
    python test_runner.py --base-url http://localhost:8080 --required-only
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin

try:
    import requests
except ImportError:
    print("Error: 'requests' library required. Install with: pip install requests")
    sys.exit(1)


class TestResult:
    """Result of a single test"""
    PASS = "PASS"
    FAIL = "FAIL"
    SKIP = "SKIP"
    ERROR = "ERROR"

    def __init__(self, test_id: str, name: str, status: str, message: str = ""):
        self.test_id = test_id
        self.name = name
        self.status = status
        self.message = message


class JsonPathEvaluator:
    """Simple JSONPath evaluator for test assertions"""

    @staticmethod
    def get(data: Any, path: str) -> Tuple[bool, Any]:
        """
        Get value at JSONPath. Returns (found, value).

        Supported syntax:
        - $ : root
        - $.field : object field
        - $[0] : array index
        - $[*] : all array items
        """
        if path == "$":
            return True, data

        # Remove leading $
        if path.startswith("$."):
            path = path[2:]
        elif path.startswith("$["):
            path = path[1:]
        elif path.startswith("$"):
            path = path[1:]

        current = data
        parts = JsonPathEvaluator._split_path(path)

        for part in parts:
            if part == "*":
                # Return all items - handled specially in assertions
                if not isinstance(current, list):
                    return False, None
                return True, current
            elif part.isdigit():
                idx = int(part)
                if not isinstance(current, list) or idx >= len(current):
                    return False, None
                current = current[idx]
            else:
                if not isinstance(current, dict) or part not in current:
                    return False, None
                current = current[part]

        return True, current

    @staticmethod
    def _split_path(path: str) -> List[str]:
        """Split path into parts, handling brackets and dots"""
        parts = []
        current = ""
        i = 0
        while i < len(path):
            char = path[i]
            if char == ".":
                if current:
                    parts.append(current)
                    current = ""
            elif char == "[":
                if current:
                    parts.append(current)
                    current = ""
                # Find closing bracket
                j = i + 1
                while j < len(path) and path[j] != "]":
                    j += 1
                parts.append(path[i + 1 : j])
                i = j
            else:
                current += char
            i += 1
        if current:
            parts.append(current)
        return parts


class I3XTestRunner:
    """Test runner for I3X compliance tests"""

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout: int = 30,
        verbose: bool = False,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.verbose = verbose
        self.session = requests.Session()
        self.saved_values: Dict[str, Any] = {}

        # Set default headers
        self.session.headers["Content-Type"] = "application/json"
        self.session.headers["Accept"] = "application/json"
        if api_key:
            self.session.headers["X-API-Key"] = api_key

    def run_all(
        self,
        category: Optional[str] = None,
        required_only: bool = False,
    ) -> List[TestResult]:
        """Run all tests, optionally filtered by category"""
        results = []
        test_dir = Path(__file__).parent

        categories = ["exploratory", "values", "subscriptions"]
        if category:
            categories = [category]

        for cat in categories:
            cat_dir = test_dir / cat
            if not cat_dir.exists():
                continue

            print(f"\nCategory: {cat}")
            print("-" * 40)

            for test_file in sorted(cat_dir.glob("*.json")):
                with open(test_file) as f:
                    tests = json.load(f)

                # Handle single test or array of tests
                if isinstance(tests, dict):
                    tests = [tests]

                for test in tests:
                    if required_only and not test.get("required", False):
                        result = TestResult(
                            test["id"],
                            test["name"],
                            TestResult.SKIP,
                            "Optional test skipped",
                        )
                    else:
                        result = self.run_test(test)

                    results.append(result)
                    self._print_result(result)

        return results

    def run_test(self, test: Dict[str, Any]) -> TestResult:
        """Run a single test"""
        test_id = test["id"]
        name = test["name"]

        try:
            # Reset saved values for this test
            self.saved_values = {}

            # Run setup steps
            setup = test.get("setup", [])
            for step in setup:
                success, error = self._run_step(step, save_values=True)
                if not success:
                    return TestResult(test_id, name, TestResult.ERROR, f"Setup failed: {error}")

            # Run main request
            request = test["request"]
            response = self._make_request(request)

            if self.verbose:
                self._print_verbose(request, response)

            # Run assertions
            assertions = test.get("assertions", [])
            for assertion in assertions:
                success, error = self._check_assertion(assertion, response)
                if not success:
                    return TestResult(test_id, name, TestResult.FAIL, error)

            # Run cleanup steps
            cleanup = test.get("cleanup", [])
            for step in cleanup:
                self._run_step(step, save_values=False)

            return TestResult(test_id, name, TestResult.PASS)

        except requests.RequestException as e:
            return TestResult(test_id, name, TestResult.ERROR, f"Request error: {e}")
        except Exception as e:
            return TestResult(test_id, name, TestResult.ERROR, f"Error: {e}")

    def _run_step(self, step: Dict[str, Any], save_values: bool = False) -> Tuple[bool, str]:
        """Run a setup or cleanup step"""
        response = self._make_request(step)

        if response.status_code >= 400:
            return False, f"Status {response.status_code}"

        if save_values and "save" in step:
            try:
                data = response.json()
                for var_name, json_path in step["save"].items():
                    found, value = JsonPathEvaluator.get(data, json_path)
                    if found:
                        self.saved_values[var_name] = value
            except json.JSONDecodeError:
                pass

        return True, ""

    def _make_request(self, request: Dict[str, Any]) -> requests.Response:
        """Make an HTTP request"""
        method = request["method"].upper()
        path = self._substitute_variables(request["path"])
        
        # Fix urljoin dropping the base path if the request path starts with '/'
        base = self.base_url if self.base_url.endswith("/") else self.base_url + "/"
        url = urljoin(base, path.lstrip("/"))

        kwargs: Dict[str, Any] = {"timeout": self.timeout}

        if "query" in request:
            kwargs["params"] = request["query"]

        if "headers" in request:
            kwargs["headers"] = request["headers"]

        if "body" in request:
            body = request["body"]
            if isinstance(body, str):
                body = self._substitute_variables(body)
            kwargs["json"] = body

        return self.session.request(method, url, **kwargs)

    def _substitute_variables(self, text: str) -> str:
        """Substitute ${var} placeholders with saved values"""
        for name, value in self.saved_values.items():
            text = text.replace(f"${{{name}}}", str(value))
        return text

    def _check_assertion(
        self, assertion: Dict[str, Any], response: requests.Response
    ) -> Tuple[bool, str]:
        """Check a single assertion"""
        assertion_type = assertion["type"]

        if assertion_type == "status":
            expected = assertion["value"]
            if response.status_code != expected:
                return False, f"Expected status {expected}, got {response.status_code}"
            return True, ""

        if assertion_type == "header":
            header_name = assertion["name"]
            if "exists" in assertion:
                if assertion["exists"] and header_name not in response.headers:
                    return False, f"Header '{header_name}' not found"
                if not assertion["exists"] and header_name in response.headers:
                    return False, f"Header '{header_name}' should not exist"
            if "value" in assertion:
                actual = response.headers.get(header_name)
                if actual != assertion["value"]:
                    return False, f"Header '{header_name}' expected '{assertion['value']}', got '{actual}'"
            return True, ""

        if assertion_type == "jsonPath":
            try:
                data = response.json()
            except json.JSONDecodeError:
                return False, "Response is not valid JSON"

            path = assertion["path"]
            found, value = JsonPathEvaluator.get(data, path)

            if "exists" in assertion:
                if assertion["exists"] and not found:
                    return False, f"Path '{path}' not found"
                if not assertion["exists"] and found:
                    return False, f"Path '{path}' should not exist"
                return True, ""

            if not found:
                return False, f"Path '{path}' not found"

            if "value" in assertion:
                expected = assertion["value"]
                if value != expected:
                    return False, f"Path '{path}' expected {expected}, got {value}"

            if "valueType" in assertion:
                expected_type = assertion["valueType"]
                actual_type = type(value).__name__
                type_map = {
                    "string": "str",
                    "number": ("int", "float"),
                    "boolean": "bool",
                    "array": "list",
                    "object": "dict",
                    "null": "NoneType",
                }
                expected = type_map.get(expected_type, expected_type)
                if isinstance(expected, tuple):
                    if actual_type not in expected:
                        return False, f"Path '{path}' expected type {expected_type}, got {actual_type}"
                elif actual_type != expected:
                    return False, f"Path '{path}' expected type {expected_type}, got {actual_type}"

            if "isArray" in assertion:
                is_array = isinstance(value, list)
                if assertion["isArray"] and not is_array:
                    return False, f"Path '{path}' expected array, got {type(value).__name__}"
                if not assertion["isArray"] and is_array:
                    return False, f"Path '{path}' expected non-array"

            if "minLength" in assertion:
                if not isinstance(value, (list, str)):
                    return False, f"Path '{path}' is not a list or string"
                if len(value) < assertion["minLength"]:
                    return False, f"Path '{path}' length {len(value)} < {assertion['minLength']}"

            if "contains" in assertion:
                if not isinstance(value, list):
                    return False, f"Path '{path}' is not an array"
                if assertion["contains"] not in value:
                    return False, f"Path '{path}' does not contain {assertion['contains']}"

            if "matches" in assertion:
                pattern = assertion["matches"]
                if not isinstance(value, str):
                    return False, f"Path '{path}' is not a string"
                if not re.search(pattern, value):
                    return False, f"Path '{path}' does not match pattern '{pattern}'"

            return True, ""

        return False, f"Unknown assertion type: {assertion_type}"

    def _print_result(self, result: TestResult):
        """Print a single test result"""
        status_colors = {
            TestResult.PASS: "\033[92m",  # Green
            TestResult.FAIL: "\033[91m",  # Red
            TestResult.SKIP: "\033[93m",  # Yellow
            TestResult.ERROR: "\033[91m",  # Red
        }
        reset = "\033[0m"

        color = status_colors.get(result.status, "")
        print(f"  [{color}{result.status}{reset}] {result.test_id}: {result.name}")
        if result.message and result.status != TestResult.PASS:
            print(f"         {result.message}")

    def _print_verbose(self, request: Dict[str, Any], response: requests.Response):
        """Print verbose request/response details"""
        print(f"\n    Request: {request['method']} {request['path']}")
        if "body" in request:
            print(f"    Body: {json.dumps(request['body'], indent=2)}")
        print(f"    Response: {response.status_code}")
        try:
            print(f"    Body: {json.dumps(response.json(), indent=2)}")
        except json.JSONDecodeError:
            print(f"    Body: {response.text[:200]}...")


def print_summary(results: List[TestResult]):
    """Print test summary"""
    total = len(results)
    passed = sum(1 for r in results if r.status == TestResult.PASS)
    failed = sum(1 for r in results if r.status == TestResult.FAIL)
    skipped = sum(1 for r in results if r.status == TestResult.SKIP)
    errors = sum(1 for r in results if r.status == TestResult.ERROR)

    print("\n" + "=" * 50)
    print("Summary:")
    print(f"  Total:   {total}")
    print(f"  Passed:  {passed}")
    print(f"  Failed:  {failed}")
    print(f"  Skipped: {skipped}")
    print(f"  Errors:  {errors}")

    # Determine compliance level
    required_passed = all(
        r.status in (TestResult.PASS, TestResult.SKIP)
        for r in results
        if "test_namespaces" in r.test_id
        or "test_object_types" in r.test_id
        or "test_relationship_types" in r.test_id
        or "test_instances" in r.test_id
        or "test_current_value" in r.test_id
        or "test_vqt_format" in r.test_id
        or "test_maxdepth" in r.test_id
    )

    if failed == 0 and errors == 0:
        print("\nCompliance Level: Full")
    elif required_passed:
        print("\nCompliance Level: Core (all required tests passed)")
    else:
        print("\nCompliance Level: Not compliant")

    return failed + errors


def main():
    parser = argparse.ArgumentParser(
        description="I3X Compliance Test Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--base-url",
        required=True,
        help="Base URL of the I3X server",
    )
    parser.add_argument(
        "--category",
        choices=["exploratory", "values", "subscriptions"],
        help="Run only specific category",
    )
    parser.add_argument(
        "--required-only",
        action="store_true",
        help="Run only required tests",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Show detailed test output",
    )
    parser.add_argument(
        "--api-key",
        help="API key for authentication",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="Request timeout in seconds (default: 30)",
    )

    args = parser.parse_args()

    print("I3X Compliance Test Runner")
    print("=" * 50)
    print(f"Target: {args.base_url}")

    runner = I3XTestRunner(
        base_url=args.base_url,
        api_key=args.api_key,
        timeout=args.timeout,
        verbose=args.verbose,
    )

    results = runner.run_all(
        category=args.category,
        required_only=args.required_only,
    )

    exit_code = print_summary(results)
    sys.exit(min(exit_code, 1))


if __name__ == "__main__":
    main()
