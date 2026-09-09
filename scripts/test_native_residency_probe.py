import importlib.util
import json
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("native_residency_probe", Path(__file__).with_name("probe-native-residency.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class NativeProtocolTests(unittest.TestCase):
    def test_spawn_uses_native_task_name_result(self):
        self.assertTrue(probe.Scenario.spawn_succeeded('{"task_name":"/root/residency_probe_1"}'))
        self.assertFalse(probe.Scenario.spawn_succeeded('{"agent_name":"/root/residency_probe_1"}'))

    def test_completion_is_tagged_and_prior_eviction_does_not_hide_pending_work(self):
        scenario = probe.Scenario()
        scenario.accept_result({"callId": "s1", "tool": "spawn_agent", "arguments": probe.spawn_action(1)[1]},
                               '{"task_name":"/root/residency_probe_1"}')
        scenario.accept_result({"callId": "l1", "tool": "list_agents", "arguments": {}}, json.dumps({"agents": [
            {"agent_name": "/root", "agent_status": "running"},
            {"agent_name": "/root/residency_probe_1", "agent_status": {"completed": "CHILD_DONE"}},
        ]}))
        self.assertFalse(scenario.waiting_children)
        scenario.accept_result({"callId": "s2", "tool": "spawn_agent", "arguments": probe.spawn_action(2)[1]},
                               '{"task_name":"/root/residency_probe_2"}')
        scenario.accept_result({"callId": "l2", "tool": "list_agents", "arguments": {}}, json.dumps({"agents": [
            {"agent_name": "/root", "agent_status": "running"},
            {"agent_name": "/root/residency_probe_2", "agent_status": "running"},
        ]}))
        self.assertTrue(scenario.waiting_children)

    def test_unobserved_child_absence_cannot_be_completion(self):
        scenario = probe.Scenario()
        scenario.accept_result({"callId": "s1", "tool": "spawn_agent", "arguments": probe.spawn_action(1)[1]},
                               '{"task_name":"/root/residency_probe_1"}')
        with self.assertRaises(probe.ProbeFailure):
            scenario.accept_result({"callId": "l1", "tool": "list_agents", "arguments": {}}, '{"agents":[]}')

    def test_changed_child_identity_is_not_a_successful_spawn(self):
        scenario = probe.Scenario()
        with self.assertRaises(probe.ProbeFailure):
            scenario.accept_result({"callId": "s1", "tool": "spawn_agent", "arguments": probe.spawn_action(1)[1]},
                                   '{"task_name":"/root/residency_probe_2"}')

    def test_no_result_and_no_consumption_evidence_cannot_be_success(self):
        scenario = probe.Scenario()
        with self.assertRaises(probe.ProbeFailure):
            scenario.verdict()

    def test_generic_spawn_error_is_not_capacity_evidence(self):
        scenario = probe.Scenario()
        with self.assertRaises(probe.ProbeFailure):
            scenario.accept_result({"callId": "s10", "tool": "spawn_agent", "arguments": probe.spawn_action(10)[1]},
                                   "collab spawn failed: connection lost")

    def test_admission_alone_does_not_prove_proactive_drain(self):
        scenario = probe.Scenario()
        scenario.finished = True
        scenario.child_responses = [{"pendingRequirementsPresent": [7, 8, 9]}]
        scenario.requirements_before_recovery = []
        scenario.calls = [{"tool": "spawn_agent", "output": json.dumps({"task_name": f"/root/residency_probe_{number}"})}
                          for number in range(1, 12)]
        # A bigger/ignored capacity or eviction alone must not pass the proactive check.
        self.assertFalse(scenario.verdict()["proactiveNativeDrainObserved"])

    def test_snapshot_cannot_add_a_child_that_was_not_dispatched(self):
        scenario = probe.Scenario()
        with self.assertRaises(probe.ProbeFailure):
            scenario.accept_result({"callId": "l1", "tool": "list_agents", "arguments": {}}, json.dumps({"agents": [
                {"agent_name": "/root/residency_probe_99", "agent_status": {"completed": "CHILD_DONE"}},
            ]}))


class CooperativeProtocolTests(unittest.TestCase):
    def started_child(self):
        scenario = probe.CooperativeScenario()
        scenario.accept_result({"tool": "spawn_agent", "arguments": probe.spawn_action(1)[1]},
                               '{"task_name":"/root/residency_probe_1"}')
        return scenario

    def test_old_completed_turn_does_not_satisfy_followup(self):
        scenario = self.started_child()
        scenario.accept_result({"tool": "followup_task", "arguments": {"target": "residency_probe_1"}}, "")
        def snapshot(result):
            return json.dumps({"agents": [{"agent_name": "/root/residency_probe_1", "agent_status": {"completed": result}}]})
        scenario.accept_result({"tool": "list_agents"}, snapshot("RESIDENCY_RESULT_1_INITIAL"))
        self.assertTrue(scenario.waiting_children)
        self.assertEqual(scenario.drained_children, set())
        scenario.accept_result({"tool": "list_agents"}, snapshot("RESIDENCY_RESULT_1_APPLIED"))
        self.assertFalse(scenario.waiting_children)
        self.assertEqual(scenario.drained_children, {"/root/residency_probe_1"})

    def test_next_stage_cannot_precede_current_requirement_result(self):
        scenario = self.started_child()
        with self.assertRaises(probe.ProbeFailure):
            scenario.accept_result({"tool": "spawn_agent", "arguments": probe.spawn_action(2)[1]},
                                   '{"task_name":"/root/residency_probe_2"}')

    def test_requirement_identity_does_not_use_prefix_matches(self):
        scenario = self.started_child()
        with self.assertRaises(probe.ProbeFailure):
            scenario.child_reply({"input": ["RESIDENCY_CHILD_1. RESIDENCY_PENDING_REQUIREMENT_10."]})


if __name__ == "__main__":
    unittest.main()
