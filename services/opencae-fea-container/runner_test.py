import math
import os
import shutil
import unittest
from unittest import mock

import runner


class StructuredBlockSolveTest(unittest.TestCase):
    def test_structured_hex_mesh_counts_for_standard_fidelity(self):
        parsed = runner.parse_payload(block_benchmark_payload("standard"))
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])

        self.assertEqual(len(mesh["nodes"]), (20 + 1) * (6 + 1) * (4 + 1))
        self.assertEqual(len(mesh["elements"]), 20 * 6 * 4)
        self.assertEqual(mesh["elements"][0]["nodeIds"], [1, 2, 23, 22, 148, 149, 170, 169])

    def test_distributed_cload_sums_to_requested_total_force_vector(self):
        parsed = runner.parse_payload(block_benchmark_payload("standard"))
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)
        nodal_loads = runner.distribute_total_force_to_nodes(mesh, boundaries["loadNodeIds"], parsed["loadVector"])
        summed = [
            sum(load["components"][axis] for load in nodal_loads)
            for axis in range(3)
        ]

        self.assertEqual(summed[0], 0.0)
        self.assertEqual(summed[1], 0.0)
        self.assertAlmostEqual(summed[2], -1.0, places=12)

    def test_fixed_and_load_node_sets_are_non_empty_and_disjoint(self):
        parsed = runner.parse_payload(block_benchmark_payload("standard"))
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)

        self.assertGreater(len(boundaries["fixedNodeIds"]), 0)
        self.assertGreater(len(boundaries["loadNodeIds"]), 0)
        self.assertTrue(set(boundaries["fixedNodeIds"]).isdisjoint(boundaries["loadNodeIds"]))
        self.assertEqual(boundaries["fixedPlane"]["axis"], "x")
        self.assertEqual(boundaries["fixedPlane"]["side"], "min")
        self.assertEqual(boundaries["loadPlane"]["axis"], "x")
        self.assertEqual(boundaries["loadPlane"]["side"], "max")

    def test_solve_refuses_when_ccx_is_unavailable_and_returns_input_deck_artifact(self):
        with mock.patch.object(runner.shutil, "which", return_value=None):
            with self.assertRaises(runner.UserFacingSolveError) as context:
                runner.solve(block_benchmark_payload("standard"))

        self.assertEqual(context.exception.status, 503)
        self.assertIn("CalculiX executable unavailable", str(context.exception))
        self.assertIn("*ELEMENT, TYPE=C3D8", context.exception.payload["artifacts"]["inputDeck"])
        self.assertEqual(context.exception.payload["artifacts"]["solverResultParser"], "ccx-unavailable")

    @unittest.skipUnless(shutil.which("ccx"), "CalculiX ccx executable is not installed")
    def test_block_benchmark_runs_and_parses_calculix_results_when_ccx_exists(self):
        result = runner.solve(block_benchmark_payload("standard"))

        self.assertEqual(result["summary"]["maxStressUnits"], "MPa")
        self.assertGreaterEqual(result["summary"]["maxStress"], 0.10)
        self.assertLessEqual(result["summary"]["maxStress"], 0.30)
        self.assertEqual(result["summary"]["maxDisplacementUnits"], "mm")
        self.assertGreaterEqual(result["summary"]["maxDisplacement"], 0.0005)
        self.assertLessEqual(result["summary"]["maxDisplacement"], 0.004)
        self.assertAlmostEqual(result["summary"]["reactionForce"], 1.0, delta=0.02)
        self.assertGreaterEqual(result["summary"]["safetyFactor"], 900)
        self.assertEqual(result["summary"]["provenance"]["resultSource"], "parsed_dat")
        self.assertEqual(result["artifacts"]["solverResultParser"], "parsed-calculix-dat")


class GeneratedDynamicFieldsTest(unittest.TestCase):
    def test_solve_refuses_unsupported_non_block_payloads(self):
        with self.assertRaises(runner.UserFacingSolveError) as context:
            runner.solve({"runId": "run-test", "solverMaterial": aluminum_solver_material()})

        self.assertEqual(context.exception.status, 422)
        self.assertIn("block-like single-body", str(context.exception))

    def test_dev_fallback_flag_does_not_bypass_structured_block_validation(self):
        previous = os.environ.get(runner.GENERATED_FALLBACK_FLAG)
        os.environ[runner.GENERATED_FALLBACK_FLAG] = "1"
        try:
            with self.assertRaises(runner.UserFacingSolveError) as context:
                runner.solve({"runId": "run-test", "solverMaterial": aluminum_solver_material()})
        finally:
            if previous is None:
                os.environ.pop(runner.GENERATED_FALLBACK_FLAG, None)
            else:
                os.environ[runner.GENERATED_FALLBACK_FLAG] = previous

        self.assertEqual(context.exception.status, 422)
        self.assertIn("block-like single-body", str(context.exception))

    def test_generated_fallback_helper_marks_dev_results_with_obvious_provenance(self):
        settings = runner.normalized_dynamic_settings({})
        result = runner.generated_fallback_response(
            "run-test",
            500.0,
            aluminum_solver_material(),
            settings,
            False,
            "input deck",
            {"log": "solver log"},
            {"available": False, "files": [], "status": "generated-fallback-for-run-test"}
        )

        self.assertEqual(result["resultSource"], "generated_fallback")
        self.assertEqual(result["diagnostics"][0]["id"], "cloud-fea-generated-fallback")
        self.assertTrue(result["artifacts"]["solverResultParser"].startswith("generated-fallback-for-"))
        self.assertEqual(result["summary"]["maxStressUnits"], "MPa")
        self.assertEqual(result["summary"]["maxDisplacementUnits"], "mm")
        self.assertAlmostEqual(result["summary"]["safetyFactor"], 276.0 / result["summary"]["maxStress"])
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


def block_benchmark_payload(fidelity="standard"):
    return {
        "runId": f"run-block-{fidelity}",
        "fidelity": fidelity,
        "solverMaterial": aluminum_solver_material(),
        "displayModel": {
            "id": "display-block-benchmark",
            "bodyCount": 1,
            "dimensions": {"x": 100.0, "y": 30.0, "z": 10.0, "units": "mm"},
            "faces": [
                {"id": "face-fixed", "label": "Fixed end", "center": [0.0, 15.0, 5.0], "normal": [-1.0, 0.0, 0.0]},
                {"id": "face-load", "label": "Load end", "center": [100.0, 15.0, 5.0], "normal": [1.0, 0.0, 0.0]},
                {"id": "face-top", "label": "Top", "center": [50.0, 15.0, 10.0], "normal": [0.0, 0.0, 1.0]},
                {"id": "face-bottom", "label": "Bottom", "center": [50.0, 15.0, 0.0], "normal": [0.0, 0.0, -1.0]},
                {"id": "face-front", "label": "Front", "center": [50.0, 0.0, 5.0], "normal": [0.0, -1.0, 0.0]},
                {"id": "face-back", "label": "Back", "center": [50.0, 30.0, 5.0], "normal": [0.0, 1.0, 0.0]}
            ]
        },
        "study": {
            "id": "study-block-benchmark",
            "type": "static_stress",
            "namedSelections": [
                {"id": "fixed-selection", "name": "Fixed end", "entityType": "face", "geometryRefs": [{"bodyId": "body", "entityType": "face", "entityId": "face-fixed", "label": "Fixed end"}], "fingerprint": "fixed"},
                {"id": "load-selection", "name": "Load end", "entityType": "face", "geometryRefs": [{"bodyId": "body", "entityType": "face", "entityId": "face-load", "label": "Load end"}], "fingerprint": "load"}
            ],
            "constraints": [{"id": "constraint-fixed", "type": "fixed", "selectionRef": "fixed-selection", "parameters": {}, "status": "complete"}],
            "loads": [{"id": "load-end", "type": "force", "selectionRef": "load-selection", "parameters": {"value": 1.0, "direction": [0.0, 0.0, -1.0]}, "status": "complete"}],
            "solverSettings": {},
        }
    }


if __name__ == "__main__":
    unittest.main()
