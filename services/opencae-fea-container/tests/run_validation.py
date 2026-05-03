#!/usr/bin/env python3
"""OpenCAE Cloud FEA validation checks.

This suite runs without Cloudflare. CalculiX-backed checks are skipped when
`ccx` is not installed; analytical and artifact checks still run.
"""

from __future__ import annotations

import math
import base64
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(ROOT))

import runner  # noqa: E402


ALUMINUM_6061 = {
    "id": "mat-aluminum-6061",
    "name": "Aluminum 6061",
    "category": "metal",
    "youngsModulusMpa": 68900.0,
    "poissonRatio": 0.33,
    "densityTonnePerMm3": 2.7e-9,
    "yieldMpa": 276.0,
}

PETG = {
    "id": "mat-petg",
    "name": "PETG",
    "category": "plastic",
    "youngsModulusMpa": 2100.0,
    "poissonRatio": 0.38,
    "densityTonnePerMm3": 1.27e-9,
    "yieldMpa": 50.0,
}

DIMENSIONS = {"x": 100.0, "y": 30.0, "z": 10.0}


class ValidationSuite(unittest.TestCase):
    def test_cantilever_hand_estimate_guards_against_28mpa_regression(self):
        stress = cantilever_bending_stress_mpa(1.0, DIMENSIONS)
        displacement = cantilever_tip_displacement_mm(1.0, DIMENSIONS, ALUMINUM_6061["youngsModulusMpa"])
        safety_factor = ALUMINUM_6061["yieldMpa"] / stress

        self.assertGreaterEqual(stress, 0.10)
        self.assertLessEqual(stress, 0.30)
        self.assertLess(stress, 1.0)
        self.assertGreaterEqual(displacement, 0.0005)
        self.assertLessEqual(displacement, 0.004)
        self.assertGreaterEqual(safety_factor, 500)

    def test_mesh_deck_load_sum_and_parser_artifacts_for_cantilever(self):
        parsed = runner.parse_payload(block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 1.0, "standard"))
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)
        nodal_loads = runner.distribute_normalized_loads_to_nodes(parsed, mesh, boundaries)
        deck = runner.write_calculix_input_deck(parsed, mesh, boundaries, nodal_loads)

        self.assertEqual(len(mesh["nodes"]), (20 + 1) * (6 + 1) * (4 + 1))
        self.assertEqual(len(mesh["elements"]), 20 * 6 * 4)
        self.assertLoadSums(nodal_loads, [0.0, 0.0, -1.0])
        self.assertTrue(set(boundaries["fixedNodeIds"]).isdisjoint(boundaries["loadNodeIds"]))
        self.assertIn("*NODE PRINT, NSET=NALL", deck)
        self.assertIn("*EL PRINT, ELSET=SOLID", deck)
        self.assertIn("*NODE FILE, NSET=NALL", deck)
        self.assertIn("*EL FILE, ELSET=SOLID", deck)

        with tempfile.TemporaryDirectory() as tmp:
            workdir = Path(tmp)
            (workdir / "opencae_solve.dat").write_text(dat_fixture())
            parsed_results = runner.parse_calculix_result_files(workdir, "validation-parser")
        self.assertEqual(parsed_results["status"], "parsed-calculix-dat")
        self.assertAlmostEqual(parsed_results["stresses"][0]["vonMises"], 0.2)

    def test_calculix_dat_parser_accepts_legacy_and_context_signatures(self):
        with tempfile.TemporaryDirectory() as tmp:
            workdir = Path(tmp)
            (workdir / "opencae_solve.dat").write_text(dat_fixture())

            legacy_result = runner.parse_calculix_result_files(workdir, "validation-parser")
            context_result = runner.parse_calculix_result_files(workdir, "validation-parser", {"mesh": {}, "boundaries": {}})
            extra_args_result = runner.parse_calculix_result_files(
                workdir,
                "validation-parser",
                {"mesh": {}, "boundaries": {}},
                "ignored",
                ignored=True,
            )

        self.assertEqual(legacy_result["status"], "parsed-calculix-dat")
        self.assertEqual(context_result["status"], "parsed-calculix-dat")
        self.assertEqual(extra_args_result["status"], "parsed-calculix-dat")
        self.assertAlmostEqual(legacy_result["stresses"][0]["vonMises"], 0.2)
        self.assertAlmostEqual(context_result["stresses"][0]["vonMises"], legacy_result["stresses"][0]["vonMises"])
        self.assertAlmostEqual(extra_args_result["stresses"][0]["vonMises"], legacy_result["stresses"][0]["vonMises"])

    def test_calculix_frd_parser_supplies_nodal_stress_visualization_samples(self):
        with tempfile.TemporaryDirectory() as tmp:
            workdir = Path(tmp)
            (workdir / "opencae_solve.dat").write_text(dat_fixture())
            (workdir / "opencae_solve.frd").write_text(frd_fixture())

            parsed_results = runner.parse_calculix_result_files(workdir, "validation-frd-parser")

        self.assertEqual(parsed_results["status"], "parsed-calculix-dat")
        self.assertEqual(parsed_results["resultSource"], "parsed_frd_dat")
        self.assertEqual(parsed_results["visualizationSource"], "frd_nodal_stress")
        self.assertEqual(len(parsed_results["nodalStresses"]), 5)
        self.assertEqual(parsed_results["nodalStresses"][0]["nodeId"], 1)
        self.assertEqual(parsed_results["nodalStresses"][0]["point"], [0.0, 15.0, 12.0])
        self.assertAlmostEqual(parsed_results["nodalStresses"][-1]["vonMises"], 0.15)
        self.assertEqual(parsed_results["frdDisplacements"][5], [0.0, 0.0, -0.002])

    def test_handler_generic_exception_returns_python_exception_artifacts(self):
        class CapturingHandler(runner.Handler):
            def __init__(self):
                self.path = "/solve"
                self.headers = {"content-length": "2"}
                self.rfile = io.BytesIO(b"{}")
                self.status = None
                self.payload = None

            def _json(self, status, payload):
                self.status = status
                self.payload = payload

        handler = CapturingHandler()
        with mock.patch.object(runner, "solve", side_effect=RuntimeError("boom")):
            handler.do_POST()

        self.assertEqual(handler.status, 500)
        self.assertEqual(handler.payload["artifacts"]["solverResultParser"], "python-exception")
        self.assertIn("Traceback", handler.payload["artifacts"]["solverLog"])
        self.assertIn("RuntimeError: boom", handler.payload["artifacts"]["solverLog"])
        self.assertEqual(handler.payload["artifacts"]["exceptionPhase"], "solve")

    def test_handler_json_writer_serializes_success_and_error_payloads(self):
        handler = JsonCapturingHandler()

        handler._json(200, {"ok": True, "runnerVersion": "test-runner"})
        success = json_payload_from_handler(handler)
        self.assertEqual(handler.status, 200)
        self.assertEqual(success["ok"], True)
        self.assertEqual(success["runnerVersion"], "test-runner")

        handler = JsonCapturingHandler()
        handler._json(422, {"error": "bad input", "artifacts": {"solverResultParser": "validation-error"}})
        error = json_payload_from_handler(handler)
        self.assertEqual(handler.status, 422)
        self.assertEqual(error["error"], "bad input")
        self.assertEqual(error["artifacts"]["solverResultParser"], "validation-error")

    def test_handler_json_writer_falls_back_for_non_serializable_payloads(self):
        handler = JsonCapturingHandler()

        handler._json(200, {"ok": True, "bad": object()})
        payload = json_payload_from_handler(handler)

        self.assertEqual(handler.status, 500)
        self.assertIn("failed to serialize", payload["error"])
        self.assertEqual(payload["artifacts"]["solverResultParser"], "python-response-serialization-exception")
        self.assertEqual(payload["artifacts"]["exceptionPhase"], "response-serialization")

    def test_axial_tension_f_over_a_units_and_load_distribution(self):
        parsed = runner.parse_payload(block_payload("axial", ALUMINUM_6061, [1, 0, 0], 1.0, "standard"))
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)
        nodal_loads = runner.distribute_normalized_loads_to_nodes(parsed, mesh, boundaries)

        self.assertAlmostEqual(axial_stress_mpa(1.0, DIMENSIONS), 1.0 / (30.0 * 10.0))
        self.assertLoadSums(nodal_loads, [1.0, 0.0, 0.0])

    def test_force_load_normalizes_to_surface_force_vector(self):
        payload = block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 500.0, "standard")
        normalized = runner.normalize_loads(payload["study"], payload)

        self.assertEqual(len(normalized), 1)
        self.assertEqual(normalized[0]["kind"], "surface_force")
        self.assertEqual(normalized[0]["sourceLoadId"], "load-main")
        self.assertEqual(normalized[0]["selectionRef"], "load-x-selection")
        self.assertEqual(normalized[0]["units"], "N")
        self.assertLoadVectorAlmostEqual(normalized[0]["totalForceN"], [0.0, 0.0, -500.0])

    def test_payload_mass_gravity_load_normalizes_to_equivalent_force(self):
        payload = block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 10.0, "standard")
        payload["study"]["loads"][0] = {
            "id": "load-payload",
            "type": "gravity",
            "selectionRef": "load-x-selection",
            "parameters": {"value": 10.0, "units": "kg", "direction": [0, 0, -1]},
            "status": "complete",
        }

        parsed = runner.parse_payload(payload)

        self.assertEqual(parsed["loads"][0]["kind"], "surface_force")
        self.assertLoadVectorAlmostEqual(parsed["loads"][0]["totalForceN"], [0.0, 0.0, -98.0665])

    def test_beam_demo_payload_mass_creates_deck_with_equivalent_cload(self):
        payload = block_payload("cantilever", ALUMINUM_6061, [0, -1, 0], 0.497664, "standard")
        payload["study"]["loads"][0] = {
            "id": "load-end-payload",
            "type": "gravity",
            "selectionRef": "load-x-selection",
            "parameters": {"value": 0.497664, "units": "kg", "direction": [0, -1, 0]},
            "status": "complete",
        }
        parsed = runner.parse_payload(payload)
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)
        nodal_loads = runner.distribute_normalized_loads_to_nodes(parsed, mesh, boundaries)
        deck = runner.write_calculix_input_deck(parsed, mesh, boundaries, nodal_loads)

        self.assertIn("*CLOAD", deck)
        self.assertLoadSums(nodal_loads, [0.0, -0.497664 * runner.STANDARD_GRAVITY, 0.0])

    def test_pressure_load_converts_to_equivalent_nodal_force(self):
        payload = block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 100.0, "standard")
        payload["displayModel"]["dimensions"] = {"x": 100.0, "y": 24.0, "z": 24.0, "units": "mm"}
        for face in payload["displayModel"]["faces"]:
            if face["id"] == "face-fixed":
                face["center"] = [0.0, 12.0, 12.0]
            elif face["id"] == "face-load-x":
                face["center"] = [100.0, 12.0, 12.0]
        payload["study"]["loads"][0] = {
            "id": "load-pressure",
            "type": "pressure",
            "selectionRef": "load-x-selection",
            "parameters": {"value": 100.0, "units": "kPa", "direction": [0, 0, -1]},
            "status": "complete",
        }
        parsed = runner.parse_payload(payload)
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)
        nodal_loads = runner.distribute_normalized_loads_to_nodes(parsed, mesh, boundaries)

        self.assertEqual(parsed["loads"][0]["kind"], "surface_pressure")
        self.assertAlmostEqual(parsed["loads"][0]["pressureNPerMm2"], 0.1)
        self.assertLoadSums(nodal_loads, [0.0, 0.0, -57.6])

    def test_multiple_loads_and_fixed_supports_are_combined(self):
        payload = block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 10.0, "standard")
        payload["study"]["constraints"] = [
            {"id": "constraint-fixed-x", "type": "fixed", "selectionRef": "fixed-selection", "parameters": {}, "status": "complete"},
            {"id": "constraint-fixed-bottom", "type": "fixed", "selectionRef": "bottom-selection", "parameters": {}, "status": "complete"},
        ]
        payload["study"]["namedSelections"].append(selection("bottom-selection", "face-bottom"))
        payload["study"]["loads"] = [
            {"id": "load-z", "type": "force", "selectionRef": "load-x-selection", "parameters": {"value": 10.0, "direction": [0, 0, -1]}, "status": "complete"},
            {"id": "load-y", "type": "force", "selectionRef": "load-x-selection", "parameters": {"value": 5.0, "direction": [0, -1, 0]}, "status": "complete"},
        ]
        parsed = runner.parse_payload(payload)
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)
        nodal_loads = runner.distribute_normalized_loads_to_nodes(parsed, mesh, boundaries)

        fixed_x = set(runner.node_ids_on_plane(mesh, {"axis": "x", "side": "min", "coordinate": 0.0}))
        fixed_bottom = set(runner.node_ids_on_plane(mesh, {"axis": "z", "side": "min", "coordinate": 0.0}))
        self.assertEqual(set(boundaries["fixedNodeIds"]), fixed_x | fixed_bottom)
        self.assertLoadSums(nodal_loads, [0.0, -5.0, -10.0])

    def test_unsupported_loads_fail_with_clear_diagnostics(self):
        payload = block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 1.0, "standard")
        payload["study"]["loads"][0] = {
            "id": "load-payload",
            "type": "gravity",
            "selectionRef": "load-x-selection",
            "parameters": {"units": "kg", "direction": [0, 0, -1]},
            "status": "complete",
        }

        with self.assertRaises(runner.UserFacingSolveError) as context:
            runner.parse_payload(payload)

        self.assertEqual(context.exception.status, 422)
        self.assertIn("Payload mass load could not be converted", str(context.exception))
        self.assertIn("diagnostics", context.exception.payload)

    def test_material_swap_displacement_scales_with_inverse_youngs_modulus(self):
        aluminum_displacement = cantilever_tip_displacement_mm(1.0, DIMENSIONS, ALUMINUM_6061["youngsModulusMpa"])
        petg_displacement = cantilever_tip_displacement_mm(1.0, DIMENSIONS, PETG["youngsModulusMpa"])
        ratio = petg_displacement / aluminum_displacement

        self.assertAlmostEqual(cantilever_bending_stress_mpa(1.0, DIMENSIONS), cantilever_bending_stress_mpa(1.0, DIMENSIONS), delta=1e-12)
        self.assertGreater(ratio, 25)
        self.assertLess(ratio, 40)

    def test_load_scaling_doubles_stress_and_displacement_and_halves_safety_factor(self):
        stress_1n = cantilever_bending_stress_mpa(1.0, DIMENSIONS)
        stress_2n = cantilever_bending_stress_mpa(2.0, DIMENSIONS)
        disp_1n = cantilever_tip_displacement_mm(1.0, DIMENSIONS, ALUMINUM_6061["youngsModulusMpa"])
        disp_2n = cantilever_tip_displacement_mm(2.0, DIMENSIONS, ALUMINUM_6061["youngsModulusMpa"])

        self.assertAlmostEqual(stress_2n / stress_1n, 2.0)
        self.assertAlmostEqual(disp_2n / disp_1n, 2.0)
        self.assertAlmostEqual((ALUMINUM_6061["yieldMpa"] / stress_2n) / (ALUMINUM_6061["yieldMpa"] / stress_1n), 0.5)

    def test_mesh_convergence_densities_are_reasonable(self):
        previous_nodes = 0
        previous_elements = 0
        for fidelity in ["standard", "detailed", "ultra"]:
            parsed = runner.parse_payload(block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 1.0, fidelity))
            mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
            self.assertGreater(len(mesh["nodes"]), previous_nodes)
            self.assertGreater(len(mesh["elements"]), previous_elements)
            previous_nodes = len(mesh["nodes"])
            previous_elements = len(mesh["elements"])

    def test_validation_rejects_generated_or_fallback_provenance(self):
        bad_result = {
            "summary": {
                "maxStress": 28.7,
                "safetyFactor": 9.6,
                "provenance": {"kind": "calculix_fea", "resultSource": "generated"},
            },
            "fields": [{"samples": [{"source": "generated-cantilever-fallback"}]}],
        }

        with self.assertRaises(AssertionError):
            assert_no_generated_fallback(bad_result)

    def test_structured_block_solver_points_map_to_display_space(self):
        dimensions = {"x": 180.0, "y": 24.0, "z": 24.0}
        payload = viewer_space_block_payload(dimensions)
        parsed = runner.parse_payload(payload)
        solver_bounds = runner.solver_bounds_for_structured_block(parsed["dimensions"])
        display_bounds = {
            "min": [-1.9, -0.25, -0.36],
            "max": [1.9, 0.25, 0.36],
            "coordinateSpace": "display_model",
        }

        self.assertEqual(runner.solver_point_to_display([0.0, 12.0, 12.0], solver_bounds, display_bounds), [-1.9, 0.0, 0.0])
        self.assertEqual(runner.solver_point_to_display([180.0, 12.0, 12.0], solver_bounds, display_bounds), [1.9, 0.0, 0.0])
        self.assertEqual(runner.solver_point_to_display([90.0, 12.0, 12.0], solver_bounds, display_bounds), [0.0, 0.0, 0.0])

    def test_result_render_bounds_are_preferred_over_sparse_face_centers(self):
        dimensions = {"x": 180.0, "y": 24.0, "z": 24.0}
        payload = viewer_space_block_payload(dimensions)
        payload["displayModel"]["faces"] = [
            {"id": "face-fixed", "label": "Fixed X min", "center": [-1.9, 0.0, 0.0], "normal": [-1.0, 0.0, 0.0]},
            {"id": "face-load-x", "label": "X max", "center": [1.9, 0.0, 0.0], "normal": [1.0, 0.0, 0.0]},
        ]
        payload["resultRenderBounds"] = {
            "min": [-1.9, -0.25, -0.36],
            "max": [1.9, 0.25, 0.36],
            "coordinateSpace": "display_model",
        }
        parsed = runner.parse_payload(payload)

        bounds = runner.display_bounds_for_payload(parsed)

        self.assertEqual(bounds["min"], [-1.9, -0.25, -0.36])
        self.assertEqual(bounds["max"], [1.9, 0.25, 0.36])
        self.assertEqual(bounds["coordinateSpace"], "display_model")

    def test_structured_block_result_samples_are_display_space_without_changing_values(self):
        dimensions = {"x": 180.0, "y": 24.0, "z": 24.0}
        payload = viewer_space_block_payload(dimensions)
        payload["resultRenderBounds"] = {
            "min": [-1.9, -0.25, -0.36],
            "max": [1.9, 0.25, 0.36],
            "coordinateSpace": "display_model",
        }
        parsed = runner.parse_payload(payload)
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)
        parsed_files = {
            **runner.parse_dat_result(dat_fixture(), mesh),
            "files": ["opencae_solve.dat"],
            "status": "parsed-calculix-dat",
            "resultSource": "parsed_dat"
        }

        result = runner.response_from_parsed_dat(parsed, mesh, boundaries, "input deck", {"log": "solver log"}, parsed_files)

        self.assertCloudResultIsParsed(result)
        self.assertAlmostEqual(result["summary"]["maxStress"], 0.2)
        self.assertAlmostEqual(result["summary"]["maxDisplacement"], 0.0019)
        self.assertAlmostEqual(result["summary"]["reactionForce"], 1.0)
        self.assertAlmostEqual(result["summary"]["safetyFactor"], ALUMINUM_6061["yieldMpa"] / 0.2)
        self.assertEqual(result["summary"]["provenance"]["renderCoordinateSpace"], "display_model")
        self.assertEqual(result["artifacts"]["meshSummary"]["solverCoordinateSpace"], "mm")
        self.assertEqual(result["artifacts"]["meshSummary"]["resultSampleCoordinateSpace"], "display_model")

        display_min = [-1.9, -0.25, -0.36]
        display_max = [1.9, 0.25, 0.36]
        for field in result["fields"]:
            for sample in field["samples"]:
                self.assertNotIn("generated", sample.get("source", "").lower())
                self.assertNotIn("fallback", sample.get("source", "").lower())
                for axis, coordinate in enumerate(sample["point"]):
                    self.assertGreaterEqual(coordinate, display_min[axis] - 1e-9)
                    self.assertLessEqual(coordinate, display_max[axis] + 1e-9)
        all_coordinates = [abs(coordinate) for field in result["fields"] for sample in field["samples"] for coordinate in sample["point"]]
        self.assertLessEqual(max(all_coordinates), 1.9)

    def test_dat_stress_fallback_returns_surface_nodal_visualization_field(self):
        dimensions = {"x": 180.0, "y": 24.0, "z": 24.0}
        payload = viewer_space_block_payload(dimensions)
        payload["resultRenderBounds"] = {
            "min": [-1.9, -0.25, -0.36],
            "max": [1.9, 0.25, 0.36],
            "coordinateSpace": "display_model",
        }
        parsed = runner.parse_payload(payload)
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)
        parsed_files = {
            **runner.parse_dat_result(dat_fixture_with_element_gradient(), mesh),
            "files": ["opencae_solve.dat"],
            "status": "parsed-calculix-dat",
            "resultSource": "parsed_dat",
        }

        result = runner.response_from_parsed_dat(parsed, mesh, boundaries, "input deck", {"log": "solver log"}, parsed_files)
        fields = {field["type"]: field for field in result["fields"]}
        stress = fields["stress"]

        self.assertEqual(stress["location"], "node")
        self.assertEqual(stress["samples"][0]["source"], "calculix-nodal-surface")
        self.assertEqual(stress["min"], min(sample["value"] for sample in stress["samples"]))
        self.assertEqual(stress["max"], max(sample["value"] for sample in stress["samples"]))
        self.assertGreater(len(stress["samples"]), 100)
        self.assertGreater(len({round(sample["value"], 6) for sample in stress["samples"]}), 3)
        self.assertAlmostEqual(result["summary"]["maxStress"], 0.2)
        for sample in stress["samples"]:
            self.assertGreaterEqual(sample["point"][0], -1.9 - 1e-9)
            self.assertLessEqual(sample["point"][0], 1.9 + 1e-9)
            self.assertNotIn("generated", sample.get("source", "").lower())
            self.assertNotIn("fallback", sample.get("source", "").lower())
            self.assertNotIn("heuristic", sample.get("source", "").lower())
            self.assertNotIn("local_detailed", sample.get("source", "").lower())

    def test_structured_block_uses_frd_nodal_stress_field_without_changing_dat_summary(self):
        dimensions = {"x": 180.0, "y": 30.0, "z": 24.0}
        parsed = runner.parse_payload(viewer_space_block_payload(dimensions))
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)
        parsed_files = {
            **runner.parse_dat_result(dat_fixture(), mesh),
            "nodalStresses": runner.parse_frd_nodal_stresses(frd_fixture(), mesh),
            "frdDisplacements": runner.parse_frd_nodal_displacements(frd_fixture()),
            "parserDiagnostics": [],
            "files": ["opencae_solve.dat", "opencae_solve.frd"],
            "status": "parsed-calculix-dat",
            "resultSource": "parsed_frd_dat",
            "visualizationSource": "frd_nodal_stress"
        }

        result = runner.response_from_parsed_dat(parsed, mesh, boundaries, "input deck", {"log": "solver log"}, parsed_files)
        fields = {field["type"]: field for field in result["fields"]}
        stress_samples = fields["stress"]["samples"]

        self.assertAlmostEqual(result["summary"]["maxStress"], 0.2)
        self.assertAlmostEqual(fields["stress"]["max"], 0.15)
        self.assertEqual(fields["stress"]["location"], "node")
        self.assertEqual(fields["safety_factor"]["location"], "node")
        self.assertEqual(fields["stress"]["samples"][0]["source"], "calculix-nodal-surface")
        self.assertEqual(result["artifacts"]["resultCoordinateMapping"]["resultSampleCoordinateSpace"], "display_model")
        self.assertGreater(len({round(sample["value"], 6) for sample in stress_samples}), 3)
        self.assertGreater(len({round(sample["point"][0], 6) for sample in stress_samples}), 3)
        for sample in stress_samples:
            self.assertGreaterEqual(sample["point"][0], -1.9 - 1e-9)
            self.assertLessEqual(sample["point"][0], 1.9 + 1e-9)
            self.assertNotIn("generated", sample.get("source", "").lower())
            self.assertNotIn("fallback", sample.get("source", "").lower())

    def test_ultra_structured_block_result_is_compacted_without_changing_summary(self):
        parsed = runner.parse_payload(block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 1.0, "ultra"))
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)
        displacement_scale = 0.0042 / max(node["coordinates"][0] for node in mesh["nodes"])
        displacements = {
            node["id"]: [0.0, 0.0, -node["coordinates"][0] * displacement_scale]
            for node in mesh["nodes"]
        }
        stress_count = 30_000
        full_max_stress = 12.5
        stresses = []
        for index in range(stress_count):
            element = mesh["elements"][index % len(mesh["elements"])]
            stresses.append({
                "elementId": element["id"],
                "point": runner.element_centroid(mesh, element["id"]),
                "vonMises": full_max_stress * (index + 1) / stress_count,
            })
        parsed_files = {
            "displacements": displacements,
            "reactions": {boundaries["fixedNodeIds"][0]: [0.0, 0.0, 1.0]},
            "stresses": stresses,
            "files": ["opencae_solve.dat"],
            "status": "parsed-calculix-dat",
            "resultSource": "parsed_dat",
        }

        result = runner.response_from_parsed_dat(
            parsed,
            mesh,
            boundaries,
            "input deck",
            {"log": "solver log"},
            parsed_files,
        )
        fields = {field["type"]: field for field in result["fields"]}

        self.assertCloudResultIsParsed(result)
        self.assertLessEqual(len(fields["stress"]["values"]), 25_000)
        self.assertLessEqual(len(fields["stress"]["samples"]), 20_000)
        self.assertLessEqual(len(fields["displacement"]["samples"]), 15_000)
        self.assertAlmostEqual(result["summary"]["maxStress"], full_max_stress)
        self.assertAlmostEqual(result["summary"]["maxDisplacement"], 0.0042)
        self.assertAlmostEqual(result["summary"]["safetyFactor"], ALUMINUM_6061["yieldMpa"] / full_max_stress)
        self.assertAlmostEqual(result["summary"]["reactionForce"], 1.0)
        self.assertEqual(result["artifacts"]["solverResultParser"], "parsed-calculix-dat")
        self.assertTrue(result["artifacts"]["resultCompaction"]["enabled"])
        self.assertEqual(result["artifacts"]["resultCompaction"]["originalStressSampleCount"], len(fields["stress"]["samples"]))
        self.assertEqual(result["artifacts"]["resultCompaction"]["returnedStressSampleCount"], len(fields["stress"]["samples"]))
        for field in result["fields"]:
            for sample in field["samples"]:
                self.assertNotIn("generated", sample.get("source", "").lower())
                self.assertNotIn("fallback", sample.get("source", "").lower())

    def test_uploaded_stl_fixture_requires_gmsh_and_never_falls_back_to_block(self):
        payload = uploaded_block_payload("uploaded-stl", ALUMINUM_6061, [0, 0, -1], 1.0, "standard")

        if shutil.which("gmsh"):
            self.skipTest("Gmsh is installed; missing-gmsh safe-failure check is not applicable")

        with self.assertRaises(runner.UserFacingSolveError) as context:
            runner.solve(payload)

        self.assertEqual(context.exception.status, 503)
        self.assertIn("Gmsh executable unavailable", str(context.exception))
        artifacts = context.exception.payload["artifacts"]
        self.assertEqual(artifacts["solverResultParser"], "gmsh-unavailable")
        self.assertEqual(artifacts["meshSummary"]["source"], "gmsh_uploaded_geometry")
        self.assertNotIn("*ELEMENT, TYPE=C3D8", artifacts["inputDeck"])

    def test_uploaded_geometry_face_mapping_fixture_and_ambiguous_mapping(self):
        parsed = runner.parse_payload(uploaded_block_payload("uploaded-map", ALUMINUM_6061, [0, 0, -1], 1.0, "standard"))
        mesh = runner.parse_gmsh_msh(gmsh_msh_fixture())
        boundaries = runner.select_uploaded_geometry_boundaries(parsed, mesh)

        self.assertEqual(boundaries["fixedFacetIds"], [101])
        self.assertEqual(boundaries["loadFacetIds"], [102])
        self.assertTrue(set(boundaries["fixedNodeIds"]).isdisjoint(boundaries["loadNodeIds"]))

        ambiguous_mesh = runner.parse_gmsh_msh(gmsh_msh_fixture(duplicate_load_face=True))
        with self.assertRaises(runner.UserFacingSolveError):
            runner.select_uploaded_geometry_boundaries(parsed, ambiguous_mesh)

    @unittest.skipUnless(shutil.which("gmsh") and shutil.which("ccx"), "Gmsh and CalculiX ccx executables are required")
    def test_uploaded_stl_block_with_gmsh_and_ccx_matches_cantilever_order_of_magnitude(self):
        result = runner.solve(uploaded_block_payload("uploaded-stl", ALUMINUM_6061, [0, 0, -1], 1.0, "standard"))
        self.assertCloudResultIsParsed(result, "gmsh_uploaded_geometry")
        self.assertGreaterEqual(result["summary"]["maxStress"], 0.05)
        self.assertLess(result["summary"]["maxStress"], 1.0)
        self.assertGreaterEqual(result["summary"]["safetyFactor"], 500)
        self.assertAlmostEqual(result["summary"]["reactionForce"], 1.0, delta=0.05)

    @unittest.skipUnless(shutil.which("ccx"), "CalculiX ccx executable is not installed")
    def test_cantilever_benchmark_with_ccx(self):
        result = runner.solve(block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 1.0, "standard"))
        self.assertCloudResultIsParsed(result)
        self.assertGreaterEqual(result["summary"]["maxStress"], 0.10)
        self.assertLessEqual(result["summary"]["maxStress"], 0.30)
        self.assertLess(result["summary"]["maxStress"], 1.0)
        self.assertGreaterEqual(result["summary"]["maxDisplacement"], 0.0005)
        self.assertLessEqual(result["summary"]["maxDisplacement"], 0.004)
        self.assertAlmostEqual(result["summary"]["reactionForce"], 1.0, delta=0.03)
        self.assertGreaterEqual(result["summary"]["safetyFactor"], 500)

    @unittest.skipUnless(shutil.which("ccx"), "CalculiX ccx executable is not installed")
    def test_axial_tension_with_ccx(self):
        result = runner.solve(block_payload("axial", ALUMINUM_6061, [1, 0, 0], 1.0, "standard"))
        self.assertCloudResultIsParsed(result)
        self.assertGreaterEqual(result["summary"]["maxStress"], 0.002)
        self.assertLessEqual(result["summary"]["maxStress"], 0.01)
        self.assertAlmostEqual(result["summary"]["reactionForce"], 1.0, delta=0.03)

    @unittest.skipUnless(shutil.which("ccx"), "CalculiX ccx executable is not installed")
    def test_material_swap_with_ccx(self):
        aluminum = runner.solve(block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 1.0, "standard"))
        petg = runner.solve(block_payload("cantilever", PETG, [0, 0, -1], 1.0, "standard"))
        self.assertCloudResultIsParsed(aluminum)
        self.assertCloudResultIsParsed(petg)

        self.assertLess(abs(aluminum["summary"]["maxStress"] - petg["summary"]["maxStress"]), max(aluminum["summary"]["maxStress"], petg["summary"]["maxStress"]) * 0.35)
        ratio = petg["summary"]["maxDisplacement"] / aluminum["summary"]["maxDisplacement"]
        self.assertGreater(ratio, 20)
        self.assertLess(ratio, 45)

    @unittest.skipUnless(shutil.which("ccx"), "CalculiX ccx executable is not installed")
    def test_load_scaling_with_ccx(self):
        one = runner.solve(block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 1.0, "standard"))
        two = runner.solve(block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 2.0, "standard"))
        self.assertCloudResultIsParsed(one)
        self.assertCloudResultIsParsed(two)

        self.assertGreater(two["summary"]["maxStress"] / one["summary"]["maxStress"], 1.7)
        self.assertLess(two["summary"]["maxStress"] / one["summary"]["maxStress"], 2.3)
        self.assertGreater(two["summary"]["maxDisplacement"] / one["summary"]["maxDisplacement"], 1.7)
        self.assertLess(two["summary"]["maxDisplacement"] / one["summary"]["maxDisplacement"], 2.3)
        self.assertGreater(two["summary"]["safetyFactor"] / one["summary"]["safetyFactor"], 0.43)
        self.assertLess(two["summary"]["safetyFactor"] / one["summary"]["safetyFactor"], 0.58)

    @unittest.skipUnless(shutil.which("ccx"), "CalculiX ccx executable is not installed")
    def test_mesh_convergence_with_ccx(self):
        results = [runner.solve(block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 1.0, fidelity)) for fidelity in ["standard", "detailed", "ultra"]]
        for result in results:
            self.assertCloudResultIsParsed(result)
            self.assertLess(result["summary"]["maxStress"], 1.0)
            self.assertGreaterEqual(result["summary"]["safetyFactor"], 500)

        displacements = [result["summary"]["maxDisplacement"] for result in results]
        self.assertLess(max(displacements) / min(displacements), 2.5)

    def assertLoadSums(self, nodal_loads, expected):
        summed = [sum(load["components"][axis] for load in nodal_loads) for axis in range(3)]
        for actual, target in zip(summed, expected):
            self.assertAlmostEqual(actual, target, places=10)

    def assertLoadVectorAlmostEqual(self, actual, expected):
        for actual_component, expected_component in zip(actual, expected):
            self.assertAlmostEqual(actual_component, expected_component, places=10)

    def assertCloudResultIsParsed(self, result, mesh_source="structured_block"):
        assert_no_generated_fallback(result)
        provenance = result["summary"]["provenance"]
        self.assertEqual(provenance["kind"], "calculix_fea")
        self.assertIn(provenance["resultSource"], {"parsed_dat", "parsed_frd_dat"})
        self.assertEqual(provenance["meshSource"], mesh_source)
        self.assertEqual(result["artifacts"]["solverResultParser"], "parsed-calculix-dat")


def block_payload(case_name, material, direction, force_n, fidelity):
    load_face = "face-load-z" if case_name == "top-load" else "face-load-x"
    load_selection = "load-x-selection" if load_face == "face-load-x" else "load-z-selection"
    return {
        "runId": f"validation-{case_name}-{material['id']}-{force_n:g}n-{fidelity}",
        "fidelity": fidelity,
        "solverMaterial": material,
        "displayModel": {
            "id": f"display-{case_name}",
            "bodyCount": 1,
            "dimensions": {"x": DIMENSIONS["x"], "y": DIMENSIONS["y"], "z": DIMENSIONS["z"], "units": "mm"},
            "faces": [
                {"id": "face-fixed", "label": "Fixed X min", "center": [0.0, 15.0, 5.0], "normal": [-1.0, 0.0, 0.0]},
                {"id": "face-load-x", "label": "X max", "center": [100.0, 15.0, 5.0], "normal": [1.0, 0.0, 0.0]},
                {"id": "face-load-z", "label": "Top", "center": [50.0, 15.0, 10.0], "normal": [0.0, 0.0, 1.0]},
                {"id": "face-bottom", "label": "Bottom", "center": [50.0, 15.0, 0.0], "normal": [0.0, 0.0, -1.0]},
                {"id": "face-front", "label": "Front", "center": [50.0, 0.0, 5.0], "normal": [0.0, -1.0, 0.0]},
                {"id": "face-back", "label": "Back", "center": [50.0, 30.0, 5.0], "normal": [0.0, 1.0, 0.0]},
            ],
        },
        "study": {
            "id": f"study-{case_name}",
            "type": "static_stress",
            "namedSelections": [
                selection("fixed-selection", "face-fixed"),
                selection("load-x-selection", "face-load-x"),
                selection("load-z-selection", "face-load-z"),
            ],
            "constraints": [{"id": "constraint-fixed", "type": "fixed", "selectionRef": "fixed-selection", "parameters": {}, "status": "complete"}],
            "loads": [{"id": "load-main", "type": "force", "selectionRef": load_selection, "parameters": {"value": force_n, "direction": direction}, "status": "complete"}],
            "solverSettings": {},
        },
    }


def viewer_space_block_payload(dimensions):
    payload = block_payload("cantilever", ALUMINUM_6061, [0, 0, -1], 1.0, "standard")
    payload["displayModel"]["dimensions"] = {**dimensions, "units": "mm"}
    payload["displayModel"]["faces"] = [
        {"id": "face-fixed", "label": "Fixed X min", "center": [-1.9, 0.0, 0.0], "normal": [-1.0, 0.0, 0.0]},
        {"id": "face-load-x", "label": "X max", "center": [1.9, 0.0, 0.0], "normal": [1.0, 0.0, 0.0]},
        {"id": "face-load-z", "label": "Top", "center": [0.0, 0.0, 0.16], "normal": [0.0, 0.0, 1.0]},
        {"id": "face-bottom", "label": "Bottom", "center": [0.0, 0.0, -0.16], "normal": [0.0, 0.0, -1.0]},
        {"id": "face-front", "label": "Front", "center": [0.0, -0.36, 0.0], "normal": [0.0, -1.0, 0.0]},
        {"id": "face-back", "label": "Back", "center": [0.0, 0.36, 0.0], "normal": [0.0, 1.0, 0.0]},
    ]
    return payload


def uploaded_block_payload(case_name, material, direction, force_n, fidelity):
    payload = block_payload(case_name, material, direction, force_n, fidelity)
    payload["geometry"] = {
        "format": "stl",
        "filename": "block_100x30x10_ascii.stl",
        "contentBase64": base64.b64encode((FIXTURES / "block_100x30x10_ascii.stl").read_bytes()).decode("ascii"),
    }
    return payload


def selection(selection_id, face_id):
    return {
        "id": selection_id,
        "name": face_id,
        "entityType": "face",
        "geometryRefs": [{"bodyId": "body", "entityType": "face", "entityId": face_id, "label": face_id}],
        "fingerprint": selection_id,
    }


def cantilever_bending_stress_mpa(force_n, dimensions):
    inertia = dimensions["y"] * dimensions["z"] ** 3 / 12.0
    return force_n * dimensions["x"] * (dimensions["z"] / 2.0) / inertia


def cantilever_tip_displacement_mm(force_n, dimensions, youngs_modulus_mpa):
    inertia = dimensions["y"] * dimensions["z"] ** 3 / 12.0
    return force_n * dimensions["x"] ** 3 / (3.0 * youngs_modulus_mpa * inertia)


def axial_stress_mpa(force_n, dimensions):
    return force_n / (dimensions["y"] * dimensions["z"])


def assert_no_generated_fallback(result):
    text = repr(result).lower()
    assert "generated" not in text
    assert "fallback" not in text
    assert result["summary"]["provenance"]["kind"] == "calculix_fea"
    assert result["summary"]["provenance"]["resultSource"].startswith("parsed_")


class JsonCapturingHandler(runner.Handler):
    def __init__(self):
        self.status = None
        self.headers_sent = []
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.headers_sent.append((name, value))

    def end_headers(self):
        return None


def json_payload_from_handler(handler):
    return json.loads(handler.wfile.getvalue().decode("utf-8"))


def dat_fixture():
    return """
 displacements (vx,vy,vz) for set NALL and time  0.1000000E+01

       1   0.000000E+00   0.000000E+00   0.000000E+00
       2   0.000000E+00   0.000000E+00  -1.900000E-03

 forces (fx,fy,fz) for set FIXED and time  0.1000000E+01

       1   0.000000E+00   0.000000E+00   1.000000E+00

 stresses (sxx,syy,szz,sxy,sxz,syz) for set SOLID and time  0.1000000E+01

       1   2.000000E-01   0.000000E+00   0.000000E+00   0.000000E+00   0.000000E+00   0.000000E+00
"""


def dat_fixture_with_element_gradient():
    lines = [
        " displacements (vx,vy,vz) for set NALL and time  0.1000000E+01",
        "",
        "       1   0.000000E+00   0.000000E+00   0.000000E+00",
        "       2   0.000000E+00   0.000000E+00  -1.900000E-03",
        "",
        " forces (fx,fy,fz) for set FIXED and time  0.1000000E+01",
        "",
        "       1   0.000000E+00   0.000000E+00   1.000000E+00",
        "",
        " stresses (sxx,syy,szz,sxy,sxz,syz) for set SOLID and time  0.1000000E+01",
        "",
    ]
    element_count = 20 * 6 * 4
    for element_id in range(1, element_count + 1):
        value = 0.02 + 0.18 * element_id / element_count
        lines.append(f"       {element_id}   {value:.6E}   0.000000E+00   0.000000E+00   0.000000E+00   0.000000E+00   0.000000E+00")
    return "\n".join(lines)


def frd_fixture():
    return """
    2C
 -1    1 0.000000E+00 1.500000E+01 1.200000E+01
 -1    2 4.500000E+01 1.500000E+01 1.200000E+01
 -1    3 9.000000E+01 1.500000E+01 1.200000E+01
 -1    4 1.350000E+02 1.500000E+01 1.200000E+01
 -1    5 1.800000E+02 1.500000E+01 1.200000E+01
 -3
    1PSTEP
 -4  DISP
 -5  D1
 -5  D2
 -5  D3
 -1    1 0.000000E+00 0.000000E+00 0.000000E+00
 -1    2 0.000000E+00 0.000000E+00-5.000000E-04
 -1    3 0.000000E+00 0.000000E+00-1.000000E-03
 -1    4 0.000000E+00 0.000000E+00-1.500000E-03
 -1    5 0.000000E+00 0.000000E+00-2.000000E-03
 -3
 -4  STRESS
 -5  SXX
 -5  SYY
 -5  SZZ
 -5  SXY
 -5  SXZ
 -5  SYZ
 -1    1 1.000000E-02 0.000000E+00 0.000000E+00 0.000000E+00 0.000000E+00 0.000000E+00
 -1    2 3.000000E-02 0.000000E+00 0.000000E+00 0.000000E+00 0.000000E+00 0.000000E+00
 -1    3 6.000000E-02 0.000000E+00 0.000000E+00 0.000000E+00 0.000000E+00 0.000000E+00
 -1    4 1.000000E-01 0.000000E+00 0.000000E+00 0.000000E+00 0.000000E+00 0.000000E+00
 -1    5 1.500000E-01 0.000000E+00 0.000000E+00 0.000000E+00 0.000000E+00 0.000000E+00
 -3
"""


def gmsh_msh_fixture(duplicate_load_face=False):
    extra = "\n103 2 2 0 6 2 3 6" if duplicate_load_face else ""
    return f"""$MeshFormat
2.2 0 8
$EndMeshFormat
$Nodes
8
1 0 0 0
2 100 0 0
3 100 30 0
4 0 30 0
5 0 0 10
6 100 0 10
7 100 30 10
8 0 30 10
$EndNodes
$Elements
3{extra and " + 1"}
101 2 2 0 1 1 5 4
102 2 2 0 2 2 3 6{extra}
201 4 2 0 3 1 2 4 5
$EndElements
""".replace("3 + 1", "4")


if __name__ == "__main__":
    unittest.main(verbosity=2)
