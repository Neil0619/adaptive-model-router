#!/usr/bin/env python3
"""Exercise the real V2 mailbox/residency path with local, fixed model responses.

This is a native mechanism probe, not a Router or Desktop installation acceptance.
It never connects to the user's existing tasks and does not use model credentials.
"""

import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import tempfile
import threading
import time


CAPACITY_ERROR = "collab spawn failed: agent thread limit reached"
ROOT_MARKER = "RESIDENCY_PROBE_ROOT_ONLY"
MESSAGE_MARKER = "RESIDENCY_PENDING_REQUIREMENT"


class ProbeFailure(Exception):
    pass


def spawn_action(number):
    return ("spawn_agent", {
        "task_name": f"residency_probe_{number}",
        "message": f"RESIDENCY_CHILD_{number}. Return CHILD_DONE without tools.",
        "fork_turns": "none", "model": "gpt-6-astra", "reasoning_effort": "low",
    })


class Scenario:
    """Only one root control stream; completion is checked through native lists."""

    def __init__(self):
        self.actions = []
        for number in range(1, 7):
            self.actions.extend([spawn_action(number), ("list_agents", {})])
        for number in range(7, 10):
            self.actions.extend([
                spawn_action(number), ("list_agents", {}),
                ("send_message", {"target": f"residency_probe_{number}",
                                  "message": f"{MESSAGE_MARKER}_{number}. No external actions."}),
                ("list_agents", {}),
            ])
        self.actions.extend([
            spawn_action(10),
            ("followup_task", {"target": "residency_probe_9", "message": "Process the pending requirement; return CHILD_DONE."}),
            ("list_agents", {}), spawn_action(11), ("list_agents", {}),
        ])
        # Leave no known queued work in the disposable root, including controls.
        for number in (7, 8):
            self.actions.extend([
                ("followup_task", {"target": f"residency_probe_{number}", "message": "Process the pending requirement; return CHILD_DONE."}),
                ("list_agents", {}),
            ])
        self.index = 0
        self.sequence = 0
        self.pending_call = None
        self.waiting_children = False
        self.calls = []
        self.child_responses = []
        self.requirements_before_recovery = None
        self.unobserved_children = set()
        self.completed_children = set()
        self.known_children = set()
        self.root_requests = 0
        self.finished = False
        self.lock = threading.Lock()

    def child_reply(self, request):
        wire = json.dumps(request, ensure_ascii=False)
        markers = [number for number in (7, 8, 9)
                   if f"{MESSAGE_MARKER}_{number}" in wire]
        self.child_responses.append({"pendingRequirementsPresent": markers})
        return self.final_item("CHILD_DONE")

    def response(self, request):
        # No request bodies, instructions, headers, or credential data are retained.
        wire = json.dumps(request, ensure_ascii=False)
        with self.lock:
            if ROOT_MARKER not in wire:
                return self.child_reply(request)
            self.root_requests += 1
            if self.root_requests > 160:
                raise ProbeFailure("native completion polling exceeded its bound")
            if self.pending_call:
                outputs = [item for item in request.get("input", [])
                           if item.get("type") == "function_call_output"
                           and item.get("call_id") == self.pending_call["callId"]]
                if len(outputs) != 1:
                    raise ProbeFailure("missing or repeated exact native call result")
                output = outputs[0].get("output")
                self.accept_result(self.pending_call, output)
                self.pending_call = None
            if self.waiting_children:
                action = ("list_agents", {})
            elif self.index < len(self.actions):
                action = self.actions[self.index]
                self.index += 1
            else:
                self.finished = True
                return self.final_item("RESIDENCY_PROBE_FINISHED")
            if action[0] == "followup_task" and self.requirements_before_recovery is None:
                self.requirements_before_recovery = sorted({number for response in self.child_responses
                                                           for number in response["pendingRequirementsPresent"]})
            self.sequence += 1
            call_id = f"residency_call_{self.sequence}"
            self.pending_call = {"callId": call_id, "tool": action[0], "arguments": action[1]}
            return {"type": "function_call", "id": f"fc_{call_id}", "call_id": call_id,
                    "namespace": "collaboration", "name": action[0], "arguments": json.dumps(action[1])}

    def accept_result(self, call, output):
        if not isinstance(output, str):
            raise ProbeFailure("unsupported native tool result format")
        row = {**call, "output": output}
        self.calls.append(row)
        if call["tool"] == "spawn_agent":
            number = int(call["arguments"]["task_name"].rsplit("_", 1)[1])
            if number == 10:
                # Both acceptance and the exact capacity refusal are observations.
                if output != CAPACITY_ERROR and not self.spawn_succeeded(output):
                    raise ProbeFailure("capacity control failed for an unrelated reason")
            elif not self.spawn_succeeded(output):
                raise ProbeFailure(f"required native spawn {number} failed")
            if self.spawn_succeeded(output):
                expected = f"/root/residency_probe_{number}"
                if json.loads(output)["task_name"] != expected:
                    raise ProbeFailure("native spawn identity differs from the dispatched child")
                self.unobserved_children.add(expected)
                self.known_children.add(expected)
        elif call["tool"] == "list_agents":
            try:
                snapshot = json.loads(output)
                agents = snapshot["agents"]
                statuses = {agent["agent_name"]: agent["agent_status"] for agent in agents}
            except (ValueError, KeyError, TypeError) as error:
                raise ProbeFailure("unsupported native agent snapshot") from error
            if len(statuses) != len(agents) or not self.unobserved_children <= statuses.keys():
                raise ProbeFailure("incomplete or duplicate native child snapshot")
            self.waiting_children = False
            for name, state in statuses.items():
                if name == "/root":
                    continue
                if name not in self.known_children:
                    raise ProbeFailure("unexpected native child in isolated root")
                if state == "running":
                    self.waiting_children = True
                elif isinstance(state, dict) and set(state) == {"completed"} and state["completed"] == "CHILD_DONE":
                    self.unobserved_children.discard(name)
                    self.completed_children.add(name)
                else:
                    raise ProbeFailure("child failed or entered an unrecognized state")
        elif call["tool"] in {"send_message", "followup_task"}:
            if output.strip():
                raise ProbeFailure("unsupported message response; do not infer acceptance")

    @staticmethod
    def spawn_succeeded(output):
        try:
            value = json.loads(output)
            return isinstance(value, dict) and value.get("task_name", "").startswith("/root/residency_probe_")
        except (ValueError, TypeError):
            return False

    def final_item(self, text):
        self.sequence += 1
        return {"type": "message", "id": f"residency_msg_{self.sequence}", "role": "assistant",
                "status": "completed", "phase": "final_answer",
                "content": [{"type": "output_text", "text": text, "annotations": []}]}

    def verdict(self):
        if not self.finished or self.pending_call or self.waiting_children or self.unobserved_children:
            raise ProbeFailure("probe did not finish all native controls and cleanup turns")
        spawns = [call for call in self.calls if call["tool"] == "spawn_agent"]
        if len(spawns) != 11:
            raise ProbeFailure("missing native spawn controls")
        blockage = spawns[9]["output"] == CAPACITY_ERROR
        seen = {number for response in self.child_responses
                for number in response["pendingRequirementsPresent"]}
        if seen != {7, 8, 9}:
            raise ProbeFailure("followup did not expose each pending requirement to a child")
        return {"serialSixSucceeded": all(self.spawn_succeeded(row["output"]) for row in spawns[:6]),
                "threeCompletedMailboxesBlockedAdmission": blockage,
                "newSpawnAfterDrainSucceeded": self.spawn_succeeded(spawns[10]["output"]),
                "pendingRequirementsObservedByChildren": sorted(seen),
                "requirementsObservedBeforeManualRecovery": self.requirements_before_recovery,
                "proactiveNativeDrainObserved": not blockage and self.requirements_before_recovery == [7, 8, 9],
                "routerAcceptance": "not_exercised", "desktopOwningInstance": "not_exercised"}


class CooperativeScenario(Scenario):
    """Existing native tools, with root-directed message handling before next stage.

    Synthetic child replies attest transport and turn ordering, not model quality.
    No Router implementation or native unload API is part of this control.
    """

    def __init__(self):
        super().__init__()
        self.cycles = 12
        self.actions = []
        self.expected_finals = {}
        self.drained_children = set()
        for number in range(1, self.cycles + 1):
            self.actions.extend([spawn_action(number), ("list_agents", {})])
            message = f"{MESSAGE_MARKER}_{number}. No external actions."
            if number % 2:
                # Deliberately reproduce a late QueueOnly message, then settle it
                # during normal stage closure, before any capacity failure.
                self.actions.append(("send_message", {"target": f"residency_probe_{number}", "message": message}))
                message = "Process the pending requirement for this same stage; no external actions."
            self.actions.extend([
                ("followup_task", {"target": f"residency_probe_{number}", "message": message}),
                ("list_agents", {}),
            ])

    def child_reply(self, request):
        wire = json.dumps(request, ensure_ascii=False)
        numbers = {int(value) for value in re.findall(r"RESIDENCY_CHILD_(\d+)\b", wire)}
        if len(numbers) != 1:
            raise ProbeFailure("cooperative child input has ambiguous identity")
        number = numbers.pop()
        markers = {int(value) for value in re.findall(r"RESIDENCY_PENDING_REQUIREMENT_(\d+)\b", wire)}
        if markers - {number}:
            raise ProbeFailure("cooperative child received another stage's requirement")
        self.child_responses.append({"child": number, "pendingRequirementsPresent": sorted(markers)})
        suffix = "APPLIED" if number in markers else "INITIAL"
        return self.final_item(f"RESIDENCY_RESULT_{number}_{suffix}")

    def accept_result(self, call, output):
        if not isinstance(output, str):
            raise ProbeFailure("unsupported native tool result format")
        self.calls.append({**call, "output": output})
        tool = call["tool"]
        if tool == "spawn_agent":
            number = int(call["arguments"]["task_name"].rsplit("_", 1)[1])
            if number > 1 and f"/root/residency_probe_{number - 1}" not in self.drained_children:
                raise ProbeFailure("new stage preceded the prior requirement's final result")
            name = f"/root/residency_probe_{number}"
            if not self.spawn_succeeded(output) or json.loads(output)["task_name"] != name:
                raise ProbeFailure(f"cooperative native spawn {number} failed")
            self.known_children.add(name)
            self.unobserved_children.add(name)
            self.expected_finals[name] = f"RESIDENCY_RESULT_{number}_INITIAL"
        elif tool in {"send_message", "followup_task"}:
            if output.strip():
                raise ProbeFailure("unsupported message response; do not infer acceptance")
            name = "/root/" + call["arguments"]["target"]
            if name not in self.known_children:
                raise ProbeFailure("cooperative message targeted an unknown child")
            if tool == "followup_task":
                number = int(name.rsplit("_", 1)[1])
                self.expected_finals[name] = f"RESIDENCY_RESULT_{number}_APPLIED"
                self.unobserved_children.add(name)
        elif tool == "list_agents":
            try:
                agents = json.loads(output)["agents"]
                states = {row["agent_name"]: row["agent_status"] for row in agents}
            except (ValueError, KeyError, TypeError) as error:
                raise ProbeFailure("unsupported native agent snapshot") from error
            if len(states) != len(agents) or not self.unobserved_children <= states.keys():
                raise ProbeFailure("incomplete or duplicate native child snapshot")
            self.waiting_children = False
            for name, state in states.items():
                if name == "/root":
                    continue
                if name not in self.known_children:
                    raise ProbeFailure("unexpected native child in isolated root")
                if state == "running":
                    self.waiting_children = True
                    continue
                if not isinstance(state, dict) or set(state) != {"completed"}:
                    raise ProbeFailure("child failed or entered an unrecognized state")
                expected = self.expected_finals[name]
                if state["completed"] != expected:
                    # A completed earlier turn is not the result of the followup.
                    initial = expected.removesuffix("APPLIED") + "INITIAL"
                    if expected.endswith("APPLIED") and state["completed"] == initial:
                        self.waiting_children = True
                        continue
                    raise ProbeFailure("native completion did not match this child and requirement")
                self.unobserved_children.discard(name)
                self.completed_children.add(name)
                if expected.endswith("APPLIED"):
                    self.drained_children.add(name)

    def verdict(self):
        if not self.finished or self.pending_call or self.waiting_children or self.unobserved_children:
            raise ProbeFailure("cooperative probe did not finish all current results")
        spawns = [call for call in self.calls if call["tool"] == "spawn_agent"]
        seen = {number for row in self.child_responses for number in row["pendingRequirementsPresent"]}
        if len(spawns) != self.cycles or len(self.drained_children) != self.cycles or seen != set(range(1, self.cycles + 1)):
            raise ProbeFailure("cooperative probe has incomplete stage or message evidence")
        return {"cooperativeStagesCompleted": self.cycles,
                "lateQueueOnlyStages": self.cycles // 2,
                "directFollowupStages": self.cycles // 2,
                "pendingRequirementsObservedByChildren": sorted(seen),
                "allFinalResultsMatchCurrentRequirement": True,
                "capacityRejections": sum(call["output"] == CAPACITY_ERROR for call in self.calls),
                "routerAcceptance": "not_exercised", "desktopOwningInstance": "not_exercised",
                "semanticQualityAcceptance": "not_exercised"}


def run_bounded(command, *, cwd, env, seconds, stdout_path, stderr_path, protocol_errors):
    """Drain bounded output and reap only the process group owned by this probe."""
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    deadline = time.monotonic() + seconds
    count = 0
    try:
        with stdout_path.open("wb") as out, stderr_path.open("wb") as err:
            selector.register(process.stdout, selectors.EVENT_READ, out)
            selector.register(process.stderr, selectors.EVENT_READ, err)
            while selector.get_map():
                if protocol_errors:
                    raise ProbeFailure(f"native protocol mismatch: {protocol_errors[0]}")
                if time.monotonic() >= deadline:
                    raise ProbeFailure("native probe timed out")
                for key, _ in selector.select(0.1):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    count += len(data)
                    if count > 8 * 1024 * 1024:
                        raise ProbeFailure("native probe output exceeded 8 MiB")
                    key.data.write(data)
            return process.wait(timeout=max(0.1, deadline - time.monotonic()))
    finally:
        selector.close()
        for stream in (process.stdout, process.stderr):
            stream.close()
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)
        # A leader exiting is not proof that all its children exited.
        for _ in range(30):
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            os.killpg(process.pid, signal.SIGKILL)
            raise ProbeFailure("probe process group did not become quiescent")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", type=Path, default=Path("/Applications/ChatGPT.app/Contents/Resources/codex"))
    parser.add_argument("--scenario", choices=("baseline", "cooperative"), default="baseline")
    parser.add_argument("--require-proactive", action="store_true",
                        help="Legacy baseline-only expectation of native self-drain, not a Router repair acceptance gate.")
    args = parser.parse_args()
    if args.require_proactive and args.scenario != "baseline":
        parser.error("--require-proactive only describes the native baseline, not cooperative orchestration")
    binary = args.codex.resolve(strict=True)
    version = subprocess.check_output([str(binary), "--version"], text=True, timeout=10).strip()
    scratch = Path(tempfile.mkdtemp(prefix="router-native-residency-"))
    task_codex_home = scratch / "codex-home"
    task_codex_home.mkdir()
    scenario = CooperativeScenario() if args.scenario == "cooperative" else Scenario()
    errors = []

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4 * 1024 * 1024:
                    raise ProbeFailure("request exceeded protocol bounds")
                request = json.loads(self.rfile.read(length))
                # Let native completion notifications advance; no state inferred from time.
                time.sleep(0.08)
                item = scenario.response(request)
                rid = f"residency_response_{item['id']}"
                events = [
                    ("response.created", {"response": {"id": rid, "object": "response", "status": "in_progress", "output": []}}),
                    ("response.output_item.done", {"output_index": 0, "item": item}),
                    ("response.completed", {"response": {"id": rid, "object": "response", "status": "completed", "output": [item],
                                                         "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}}),
                ]
                data = "".join(f"event: {kind}\ndata: {json.dumps({'type': kind, **value})}\n\n" for kind, value in events).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception as error:
                errors.append(str(error))
                self.send_error(500, "native residency probe protocol failure")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    provider = ('{name="Native residency control",base_url="http://127.0.0.1:'
                + str(server.server_port) + '/v1",wire_api="responses",requires_openai_auth=false}')
    command = [str(binary), "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--json",
               "--dangerously-bypass-approvals-and-sandbox", "-C", str(scratch), "-m", "gpt-6-astra",
               "-c", 'model_provider="residency_probe"', "-c", f"model_providers.residency_probe={provider}",
               "-c", "features.multi_agent_v2={enabled=true,max_concurrent_threads_per_session=4}",
               "-c", "features.responses_websockets_v2=false", "-c", "features.responses_websockets=false",
               "-c", 'model_reasoning_effort="low"', "-c", "features.hooks=false",
               f"{ROOT_MARKER}. Native mechanism test. Only the fixed synthetic collaboration operations; no business actions."]
    # This child process has a private Codex home, no auth, no user plugins, and no Router state.
    env = {key: value for key, value in os.environ.items() if key in {"PATH", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"}}
    env["CODEX_HOME"] = str(task_codex_home)
    report = {"schemaVersion": 1, "binary": str(binary), "version": version,
              "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
              "artifactDirectory": str(scratch), "syntheticResponses": True,
              "paidModelInference": False, "configuredTotalCapacity": 4,
              "installedRouterModified": False, "scenario": args.scenario}
    print(json.dumps({"started": report}), flush=True)
    try:
        code = run_bounded(command, cwd=scratch, env=env, seconds=120,
                           stdout_path=scratch / "native-stdout.jsonl", stderr_path=scratch / "native-stderr.txt",
                           protocol_errors=errors)
        if code != 0 or errors:
            raise ProbeFailure(f"native execution failed: exit={code}, protocolErrors={errors}")
        report.update(scenario.verdict())
        report["status"] = "proactive_contract_failed" if args.require_proactive and not report["proactiveNativeDrainObserved"] else "mechanism_observed"
    except (ProbeFailure, subprocess.SubprocessError) as error:
        report.update(status="probe_failed", error=str(error))
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
        report["rootRequests"] = scenario.root_requests
        report["childResponses"] = len(scenario.child_responses)
        report["nativeCalls"] = len(scenario.calls)
        (scratch / "native-calls.json").write_text(json.dumps(scenario.calls, ensure_ascii=False, indent=2) + "\n")
        (scratch / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return 0 if report["status"] == "mechanism_observed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
