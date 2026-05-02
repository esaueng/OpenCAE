import math
import os
import unittest

import runner


class GeneratedDynamicFieldsTest(unittest.TestCase):
    def test_solve_refuses_generated_fallback_by_default_when_results_are_unparsed(self):
        with self.assertRaises(runner.UserFacingSolveError) as context:
            runner.solve({"runId": "run-test"})

        self.assertEqual(context.exception.status, 422)
        self.assertIn("CalculiX output was not parsed", str(context.exception))

    def test_solve_allows_generated_fallback_only_with_dev_flag_and_obvious_provenance(self):
        previous = os.environ.get(runner.GENERATED_FALLBACK_FLAG)
        os.environ[runner.GENERATED_FALLBACK_FLAG] = "1"
        try:
            result = runner.solve({"runId": "run-test"})
        finally:
            if previous is None:
                os.environ.pop(runner.GENERATED_FALLBACK_FLAG, None)
            else:
                os.environ[runner.GENERATED_FALLBACK_FLAG] = previous

        self.assertEqual(result["resultSource"], "generated_fallback")
        self.assertEqual(result["diagnostics"][0]["id"], "cloud-fea-generated-fallback")
        self.assertTrue(result["artifacts"]["solverResultParser"].startswith("generated-fallback-for-"))
        for field in result["fields"]:
            for sample in field["samples"]:
                self.assertIn("generated-cantilever-fallback", sample["source"])

    def test_generated_dynamic_stress_frames_use_global_range_and_finite_samples(self):
        settings = runner.normalized_dynamic_settings({
            "startTime": 0.0,
            "endTime": 0.02,
            "timeStep": 0.005,
            "outputInterval": 0.005,
            "dampingRatio": 0.02,
        })

        result = runner.generated_result_fields("run-test", 500.0, runner.material_properties({}), settings, True)
        stress_frames = [field for field in result["fields"] if field["type"] == "stress"]

        self.assertGreater(len(stress_frames), 1)
        self.assertEqual({field["min"] for field in stress_frames}, {0.0})
        self.assertEqual(len({field["max"] for field in stress_frames}), 1)
        self.assertEqual(stress_frames[0]["max"], result["summary"]["maxStress"])

        frame_indexes = [field["frameIndex"] for field in stress_frames]
        times = [field["timeSeconds"] for field in stress_frames]
        self.assertEqual(frame_indexes, sorted(frame_indexes))
        self.assertEqual(times, sorted(times))

        for field in stress_frames:
            self.assertEqual(field["location"], "node")
            self.assertGreaterEqual(len(field.get("samples", [])), 8)
            for sample in field["samples"]:
                self.assertTrue(math.isfinite(sample["value"]))
                self.assertTrue(math.isfinite(sample["point"][0]))
                self.assertIn("nodeId", sample)

    def test_generated_dynamic_displacement_samples_include_changing_vectors(self):
        settings = runner.normalized_dynamic_settings({
            "startTime": 0.0,
            "endTime": 0.02,
            "timeStep": 0.005,
            "outputInterval": 0.005,
            "dampingRatio": 0.02,
        })

        result = runner.generated_result_fields("run-test", 500.0, runner.material_properties({}), settings, True)
        displacement_frames = [field for field in result["fields"] if field["type"] == "displacement"]
        first_frame = displacement_frames[0]
        peak_frame = max(displacement_frames, key=lambda field: max(sample["value"] for sample in field["samples"]))

        self.assertGreater(len(displacement_frames), 1)
        self.assertEqual({field["min"] for field in displacement_frames}, {0.0})
        self.assertEqual(len({field["max"] for field in displacement_frames}), 1)

        first_magnitudes = [math.sqrt(sum(component * component for component in sample["vector"])) for sample in first_frame["samples"]]
        peak_magnitudes = [math.sqrt(sum(component * component for component in sample["vector"])) for sample in peak_frame["samples"]]

        self.assertLess(max(first_magnitudes), 1e-12)
        self.assertGreater(max(peak_magnitudes), 0)
        for sample in peak_frame["samples"]:
            self.assertIn("vector", sample)
            self.assertEqual(len(sample["vector"]), 3)
            for component in sample["vector"]:
                self.assertTrue(math.isfinite(component))
            self.assertAlmostEqual(sample["value"], math.sqrt(sum(component * component for component in sample["vector"])))


if __name__ == "__main__":
    unittest.main()
