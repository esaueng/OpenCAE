import math
import base64
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import runner


class CalculixDatParserTest(unittest.TestCase):
    def test_von_mises_uses_six_stress_components(self):
        value = runner.von_mises([0.20, 0.02, -0.01, 0.03, 0.04, -0.02])

        expected = math.sqrt(0.5 * ((0.20 - 0.02) ** 2 + (0.02 + 0.01) ** 2 + (-0.01 - 0.20) ** 2) + 3 * (0.03 ** 2 + 0.04 ** 2 + (-0.02) ** 2))
        self.assertAlmostEqual(value, expected)

    def test_parse_calculix_result_files_reads_dat_displacements_reactions_and_integration_stresses(self):
        with tempfile.TemporaryDirectory() as tmp:
            workdir = Path(tmp)
            (workdir / "opencae_solve.dat").write_text(calculix_dat_fixture())
            (workdir / "opencae_solve.frd").write_text("frd placeholder")

            parsed = runner.parse_calculix_result_files(workdir, "run-fixture")

        self.assertEqual(parsed["status"], "parsed-calculix-dat")
        self.assertEqual(parsed["resultSource"], "parsed_frd_dat")
        self.assertEqual(parsed["files"], ["opencae_solve.dat", "opencae_solve.frd"])
        self.assertEqual(parsed["displacements"][2], [0.0, 0.0, -0.0015])
        self.assertEqual(parsed["reactions"][1], [0.0, 0.0, 1.0])
        self.assertEqual(len(parsed["stresses"]), 2)
        self.assertEqual(parsed["stresses"][1]["elementId"], 2)
        self.assertAlmostEqual(parsed["stresses"][1]["vonMises"], runner.von_mises([0.20, 0.02, -0.01, 0.03, 0.04, -0.02]))

    def test_response_uses_parsed_integration_stress_and_no_generated_sources(self):
        parsed_payload = runner.parse_payload(block_benchmark_payload("standard"))
        mesh = runner.generate_structured_hex_mesh(parsed_payload["dimensions"], parsed_payload["meshDensity"])
        boundaries = runner.select_boundary_nodes(parsed_payload, mesh)
        parsed_files = {
            **runner.parse_dat_result(calculix_dat_fixture(), mesh),
            "files": ["opencae_solve.dat"],
            "status": "parsed-calculix-dat",
            "resultSource": "parsed_dat"
        }

        result = runner.response_from_parsed_dat(parsed_payload, mesh, boundaries, "input deck", {"log": "solver log"}, parsed_files)

        expected_stress = runner.von_mises([0.20, 0.02, -0.01, 0.03, 0.04, -0.02])
        self.assertAlmostEqual(result["summary"]["maxStress"], expected_stress)
        self.assertEqual(result["summary"]["maxStressUnits"], "MPa")
        self.assertEqual(result["summary"]["maxDisplacement"], 0.0015)
        self.assertEqual(result["summary"]["maxDisplacementUnits"], "mm")
        self.assertAlmostEqual(result["summary"]["safetyFactor"], 276.0 / expected_stress)
        for field in result["fields"]:
            for sample in field["samples"]:
                self.assertNotIn("generated-cantilever-fallback", sample.get("source", ""))


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
        self.assertIn(result["summary"]["provenance"]["resultSource"], {"parsed_dat", "parsed_frd_dat"})
        self.assertEqual(result["artifacts"]["solverResultParser"], "parsed-calculix-dat")


class UploadedGeometrySolveTest(unittest.TestCase):
    def test_uploaded_geometry_refuses_missing_gmsh_before_structured_block_or_ccx(self):
        payload = uploaded_geometry_payload()
        with mock.patch.object(runner.shutil, "which", side_effect=lambda command: None if command == "gmsh" else "/usr/bin/ccx"):
            with self.assertRaises(runner.UserFacingSolveError) as context:
                runner.solve(payload)

        self.assertEqual(context.exception.status, 503)
        self.assertIn("Gmsh executable unavailable", str(context.exception))
        artifacts = context.exception.payload["artifacts"]
        self.assertEqual(artifacts["solverResultParser"], "gmsh-unavailable")
        self.assertEqual(artifacts["meshSummary"]["source"], "gmsh_uploaded_geometry")
        self.assertEqual(artifacts["geometry"]["filename"], "uploaded-block.stl")
        self.assertNotIn("*ELEMENT, TYPE=C3D8", artifacts["inputDeck"])

    def test_parse_gmsh_mesh_and_map_uploaded_face_selections(self):
        parsed = runner.parse_payload(uploaded_geometry_payload())
        mesh = runner.parse_gmsh_msh(gmsh_msh_fixture())
        boundaries = runner.select_uploaded_geometry_boundaries(parsed, mesh)

        self.assertEqual(mesh["source"], "gmsh_uploaded_geometry")
        self.assertEqual(len(mesh["nodes"]), 8)
        self.assertEqual(len(mesh["elements"]), 1)
        self.assertEqual(mesh["elements"][0]["type"], "C3D4")
        self.assertEqual(boundaries["fixedFacetIds"], [101])
        self.assertEqual(boundaries["loadFacetIds"], [102])
        self.assertEqual(boundaries["fixedNodeIds"], [1, 4, 5])
        self.assertEqual(boundaries["loadNodeIds"], [2, 3, 6])

    def test_uploaded_geometry_ambiguous_face_mapping_fails_cleanly(self):
        parsed = runner.parse_payload(uploaded_geometry_payload())
        mesh = runner.parse_gmsh_msh(gmsh_msh_fixture(duplicate_load_face=True))

        with self.assertRaises(runner.UserFacingSolveError) as context:
            runner.select_uploaded_geometry_boundaries(parsed, mesh)

        self.assertEqual(context.exception.status, 422)
        self.assertIn("could not be mapped confidently", str(context.exception))
        self.assertEqual(context.exception.payload["diagnostics"][0]["id"], "cloud-fea-uploaded-face-mapping-failed")


class GeneratedDynamicFieldsTest(unittest.TestCase):
    def test_solve_refuses_unsupported_non_block_payloads(self):
        with self.assertRaises(runner.UserFacingSolveError) as context:
            runner.solve({"runId": "run-test", "solverMaterial": aluminum_solver_material()})

        self.assertEqual(context.exception.status, 422)
        self.assertIn("block-like single-body", str(context.exception))

    def test_generated_fallback_functions_are_not_exposed_as_solver_result_path(self):
        self.assertFalse(hasattr(runner, "generated_result_fields"))
        self.assertFalse(hasattr(runner, "generated_fallback_response"))


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

def aluminum_solver_material():
    return {
        "id": "mat-aluminum-6061",
        "name": "Aluminum 6061",
        "youngsModulusMpa": 68900.0,
        "poissonRatio": 0.33,
        "densityTonnePerMm3": 2.7e-9,
        "yieldMpa": 276.0
    }


def calculix_dat_fixture():
    return """
 displacements (vx,vy,vz) for set NALL and time  0.1000000E+01

       1   0.000000E+00   0.000000E+00   0.000000E+00
       2   0.000000E+00   0.000000E+00  -1.500000E-03
       3   1.000000E-04   0.000000E+00  -9.000000E-04

 forces (fx,fy,fz) for set FIXED and time  0.1000000E+01

       1   0.000000E+00   0.000000E+00   1.000000E+00

 stresses (sxx,syy,szz,sxy,sxz,syz) for set SOLID and time  0.1000000E+01

       1   1.000000E-01   0.000000E+00   0.000000E+00   0.000000E+00   0.000000E+00   0.000000E+00
       2   2.000000E-01   2.000000E-02  -1.000000E-02   3.000000E-02   4.000000E-02  -2.000000E-02
"""


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


def uploaded_geometry_payload():
    payload = block_benchmark_payload("standard")
    fixture = Path(__file__).parent / "tests" / "fixtures" / "block_100x30x10_ascii.stl"
    payload["runId"] = "run-uploaded-geometry"
    payload["geometry"] = {
        "format": "stl",
        "filename": "uploaded-block.stl",
        "contentBase64": base64.b64encode(fixture.read_bytes()).decode("ascii")
    }
    return payload


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
    unittest.main()
