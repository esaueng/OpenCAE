import math
import unittest

import runner


class GeneratedDynamicFieldsTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
