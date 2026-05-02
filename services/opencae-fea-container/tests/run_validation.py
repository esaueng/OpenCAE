#!/usr/bin/env python3
"""OpenCAE Cloud FEA validation checks.

This suite runs without Cloudflare. CalculiX-backed checks are skipped when
`ccx` is not installed; analytical and artifact checks still run.
"""

from __future__ import annotations

import math
import base64
import io
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
        nodal_loads = runner.distribute_total_force_to_nodes(mesh, boundaries["loadNodeIds"], parsed["loadVector"])
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

    def test_axial_tension_f_over_a_units_and_load_distribution(self):
        parsed = runner.parse_payload(block_payload("axial", ALUMINUM_6061, [1, 0, 0], 1.0, "standard"))
        mesh = runner.generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed, mesh)
        nodal_loads = runner.distribute_total_force_to_nodes(mesh, boundaries["loadNodeIds"], parsed["loadVector"])

        self.assertAlmostEqual(axial_stress_mpa(1.0, DIMENSIONS), 1.0 / (30.0 * 10.0))
        self.assertLoadSums(nodal_loads, [1.0, 0.0, 0.0])

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
