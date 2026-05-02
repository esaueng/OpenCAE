import math
import os
import unittest

import runner


class GeneratedDynamicFieldsTest(unittest.TestCase):
    def test_solve_refuses_generated_fallback_by_default_when_results_are_unparsed(self):
        with self.assertRaises(runner.UserFacingSolveError) as context:
            runner.solve({"runId": "run-test", "solverMaterial": aluminum_solver_material()})

        self.assertEqual(context.exception.status, 422)
        self.assertIn("CalculiX output was not parsed", str(context.exception))

    def test_solve_allows_generated_fallback_only_with_dev_flag_and_obvious_provenance(self):
        previous = os.environ.get(runner.GENERATED_FALLBACK_FLAG)
        os.environ[runner.GENERATED_FALLBACK_FLAG] = "1"
        try:
            result = runner.solve({"runId": "run-test", "solverMaterial": aluminum_solver_material()})
        finally:
            if previous is None:
                os.environ.pop(runner.GENERATED_FALLBACK_FLAG, None)
            else:
                os.environ[runner.GENERATED_FALLBACK_FLAG] = previous

        self.assertEqual(result["resultSource"], "generated_fallback")
        self.assertEqual(result["diagnostics"][0]["id"], "cloud-fea-generated-fallback")
        self.assertTrue(result["artifacts"]["solverResultParser"].startswith("generated-fallback-for-"))
        self.assertEqual(result["summary"]["maxStressUnits"], "MPa")
        self.assertEqual(result["summary"]["maxDisplacementUnits"], "mm")
        self.assertAlmostEqual(result["summary"]["safetyFactor"], 276.0 / result["summary"]["maxStress"])
        self.assertIn("68900", result["artifacts"]["inputDeck"])
        self.assertIn("2.7e-09", result["artifacts"]["inputDeck"])
        for field in result["fields"]:
            if field["type"] == "stress":
                self.assertEqual(field["units"], "MPa")
            if field["type"] == "displacement":
                self.assertEqual(field["units"], "mm")
            for sample in field["samples"]:
                self.assertIn("generated-cantilever-fallback", sample["source"])

    def test_material_properties_reads_solver_material(self):
        material = runner.material_properties({
            "solverMaterial": {
                "id": "mat-petg",
                "name": "PETG",
                "youngsModulusMpa": 2100,
                "poissonRatio": 0.38,
                "densityTonnePerMm3": 1.27e-9,
                "yieldMpa": 50
            }
        })

        self.assertEqual(material["id"], "mat-petg")
        self.assertEqual(material["youngsModulusMpa"], 2100)
        self.assertEqual(material["poissonRatio"], 0.38)
        self.assertEqual(material["densityTonnePerMm3"], 1.27e-9)
        self.assertEqual(material["yieldMpa"], 50)

    def test_material_properties_refuses_missing_or_invalid_solver_material(self):
        for payload in [
            {},
            {"solverMaterial": {"youngsModulusMpa": 0, "poissonRatio": 0.38, "densityTonnePerMm3": 1.27e-9, "yieldMpa": 50}},
            {"solverMaterial": {"youngsModulusMpa": 2100, "poissonRatio": 0.5, "densityTonnePerMm3": 1.27e-9, "yieldMpa": 50}},
            {"solverMaterial": {"youngsModulusMpa": 2100, "poissonRatio": 0.38, "densityTonnePerMm3": -1, "yieldMpa": 50}},
            {"solverMaterial": {"youngsModulusMpa": 2100, "poissonRatio": 0.38, "densityTonnePerMm3": 1.27e-9, "yieldMpa": float("nan")}},
        ]:
            with self.subTest(payload=payload):
                with self.assertRaises(runner.UserFacingSolveError):
                    runner.material_properties(payload)

    def test_generated_dynamic_stress_frames_use_global_range_and_finite_samples(self):
        settings = runner.normalized_dynamic_settings({
            "startTime": 0.0,
            "endTime": 0.02,
            "timeStep": 0.005,
            "outputInterval": 0.005,
            "dampingRatio": 0.02,
        })

        result = runner.generated_result_fields("run-test", 500.0, aluminum_solver_material(), settings, True)
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

        result = runner.generated_result_fields("run-test", 500.0, aluminum_solver_material(), settings, True)
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


def aluminum_solver_material():
    return {
        "id": "mat-aluminum-6061",
        "name": "Aluminum 6061",
        "youngsModulusMpa": 68900.0,
        "poissonRatio": 0.33,
        "densityTonnePerMm3": 2.7e-9,
        "yieldMpa": 276.0
    }


if __name__ == "__main__":
    unittest.main()
