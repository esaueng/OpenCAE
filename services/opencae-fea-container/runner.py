from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import json
import math
import re
import shutil
import subprocess
import tempfile


UNPARSED_RESULTS_ERROR = "CalculiX output was not parsed into real result fields; refusing to publish generated fallback results."
INVALID_SOLVER_MATERIAL_ERROR = "Cloud FEA requires a valid solverMaterial with positive finite CalculiX material properties."
UNSUPPORTED_BLOCK_ERROR = "Cloud FEA currently supports only block-like single-body models with positive millimeter dimensions."
CCX_UNAVAILABLE_ERROR = "CalculiX executable unavailable; refusing to publish Cloud FEA results without a real solver run."
AXES = ("x", "y", "z")
DOFS = (1, 2, 3)
FIDELITY_MESH_DENSITY = {
    "standard": {"nx": 20, "ny": 6, "nz": 4},
    "detailed": {"nx": 40, "ny": 10, "nz": 6},
    "ultra": {"nx": 80, "ny": 16, "nz": 10}
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "solver": "calculix", "ccx": command_version(["ccx", "-v"]), "gmsh": command_version(["gmsh", "--version"])})
            return
        self._json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/solve":
            self._json(404, {"error": "Not found"})
            return
        length = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(body)
            result = solve(payload)
            self._json(200, result)
        except UserFacingSolveError as error:
            payload = {"error": str(error)}
            payload.update(error.payload)
            self._json(error.status, payload)
        except Exception as error:
            self._json(500, {"error": f"CalculiX adapter failed: {error}"})

    def log_message(self, format, *args):
        return

    def _json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class UserFacingSolveError(Exception):
    def __init__(self, message, status=422, payload=None):
        super().__init__(message)
        self.status = status
        self.payload = payload or {}


def solve(payload):
    parsed = parse_payload(payload)
    run_id = parsed["runId"]
    material = parsed["material"]
    mesh = generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
    boundaries = select_boundary_nodes(parsed, mesh)
    nodal_loads = distribute_total_force_to_nodes(mesh, boundaries["loadNodeIds"], parsed["loadVector"])

    with tempfile.TemporaryDirectory(prefix=f"{run_id}-") as tmp:
        workdir = Path(tmp)
        input_deck = write_calculix_input_deck(parsed, mesh, boundaries, nodal_loads)
        deck_path = workdir / "opencae_solve.inp"
        deck_path.write_text(input_deck)
        solver_output = run_ccx_if_available(workdir, deck_path)
        if solver_output["returnCode"] is None:
            raise UserFacingSolveError(CCX_UNAVAILABLE_ERROR, 503, {
                "artifacts": artifacts_for_failure(input_deck, solver_output, "ccx-unavailable", mesh, boundaries)
            })
        parsed_solver_results = parse_calculix_results(workdir, parsed, mesh, boundaries, input_deck, solver_output)

    if is_parsed_calculix_status(parsed_solver_results["artifacts"]["solverResultParser"]):
        return parsed_solver_results

    raise UserFacingSolveError(UNPARSED_RESULTS_ERROR, 422, {
        "artifacts": artifacts_for_failure(input_deck, solver_output, parsed_solver_results["artifacts"]["solverResultParser"], mesh, boundaries)
    })


def parse_payload(payload):
    run_id = payload.get("runId") if isinstance(payload.get("runId"), str) else "run-cloud-container"
    study = payload.get("study") if isinstance(payload.get("study"), dict) else {}
    if payload.get("analysisType") == "dynamic_structural" or study.get("type") == "dynamic_structural" or payload.get("dynamicSettings"):
        raise UserFacingSolveError("Structured block Cloud FEA currently supports static stress studies only.", 422)
    material = material_properties(payload)
    dimensions = resolve_block_dimensions(payload)
    load = first_record(study.get("loads"))
    constraint = first_record(study.get("constraints"))
    if not load or load.get("type") != "force":
        raise UserFacingSolveError("Structured block Cloud FEA requires a force load.", 422)
    if not constraint:
        raise UserFacingSolveError("Structured block Cloud FEA requires a fixed support.", 422)
    load_value = required_positive_number(load.get("parameters") if isinstance(load.get("parameters"), dict) else {}, "value")
    load_direction = unit_vector((load.get("parameters") or {}).get("direction"))
    return {
        "runId": run_id,
        "study": study,
        "displayModel": payload.get("displayModel") if isinstance(payload.get("displayModel"), dict) else {},
        "material": material,
        "dimensions": dimensions,
        "meshDensity": mesh_density_for(payload.get("fidelity")),
        "load": load,
        "constraint": constraint,
        "loadVector": [load_value * component for component in load_direction],
        "loadMagnitude": load_value
    }


def resolve_block_dimensions(payload):
    display_model = payload.get("displayModel") if isinstance(payload.get("displayModel"), dict) else None
    if not display_model:
        raise UserFacingSolveError(UNSUPPORTED_BLOCK_ERROR, 422)
    body_count = display_model.get("bodyCount")
    if isinstance(body_count, (int, float)) and body_count > 1:
        raise UserFacingSolveError(UNSUPPORTED_BLOCK_ERROR, 422)
    dimensions = display_model.get("dimensions")
    if isinstance(dimensions, dict) and dimensions.get("units") == "mm":
        resolved = {
            "x": finite_positive_dimension(dimensions.get("x")),
            "y": finite_positive_dimension(dimensions.get("y")),
            "z": finite_positive_dimension(dimensions.get("z"))
        }
        if all(resolved.values()):
            return resolved
    faces = display_model.get("faces") if isinstance(display_model.get("faces"), list) else []
    centers = [face.get("center") for face in faces if isinstance(face, dict)]
    points = [point for point in centers if is_vec3(point)]
    if len(points) < 2:
        raise UserFacingSolveError(UNSUPPORTED_BLOCK_ERROR, 422)
    mins = [min(point[index] for point in points) for index in range(3)]
    maxs = [max(point[index] for point in points) for index in range(3)]
    resolved = {axis: maxs[index] - mins[index] for index, axis in enumerate(AXES)}
    if not all(is_positive_finite(value) for value in resolved.values()):
        raise UserFacingSolveError(UNSUPPORTED_BLOCK_ERROR, 422)
    return resolved


def finite_positive_dimension(value):
    return float(value) if is_positive_finite(value) else None


def mesh_density_for(fidelity):
    return FIDELITY_MESH_DENSITY.get(fidelity if isinstance(fidelity, str) else "standard", FIDELITY_MESH_DENSITY["standard"])


def generate_structured_hex_mesh(dimensions, density):
    nx = int(density["nx"])
    ny = int(density["ny"])
    nz = int(density["nz"])
    nodes = []
    node_ids = {}
    node_id = 1
    for k in range(nz + 1):
        z = dimensions["z"] * k / nz
        for j in range(ny + 1):
            y = dimensions["y"] * j / ny
            for i in range(nx + 1):
                x = dimensions["x"] * i / nx
                node_ids[(i, j, k)] = node_id
                nodes.append({"id": node_id, "ijk": (i, j, k), "coordinates": (x, y, z)})
                node_id += 1
    elements = []
    element_id = 1
    for k in range(nz):
        for j in range(ny):
            for i in range(nx):
                node_order = [
                    node_ids[(i, j, k)],
                    node_ids[(i + 1, j, k)],
                    node_ids[(i + 1, j + 1, k)],
                    node_ids[(i, j + 1, k)],
                    node_ids[(i, j, k + 1)],
                    node_ids[(i + 1, j, k + 1)],
                    node_ids[(i + 1, j + 1, k + 1)],
                    node_ids[(i, j + 1, k + 1)]
                ]
                elements.append({"id": element_id, "ijk": (i, j, k), "nodeIds": node_order})
                element_id += 1
    return {"nodes": nodes, "elements": elements, "dimensions": dimensions, "density": {"nx": nx, "ny": ny, "nz": nz}}


def select_boundary_nodes(parsed, mesh):
    fixed_plane = plane_for_selection(parsed, parsed["constraint"].get("selectionRef"))
    load_plane = plane_for_selection(parsed, parsed["load"].get("selectionRef"))
    fixed_node_ids = node_ids_on_plane(mesh, fixed_plane)
    load_node_ids = node_ids_on_plane(mesh, load_plane)
    if not fixed_node_ids or not load_node_ids:
        raise UserFacingSolveError("Structured block boundary selection did not resolve to non-empty node sets.", 422)
    return {
        "fixedPlane": fixed_plane,
        "loadPlane": load_plane,
        "fixedNodeIds": fixed_node_ids,
        "loadNodeIds": load_node_ids,
        "diagnostics": [
            boundary_diagnostic("cloud-fea-fixed-plane", "Fixed support", fixed_plane, len(fixed_node_ids)),
            boundary_diagnostic("cloud-fea-load-plane", "Applied load", load_plane, len(load_node_ids), parsed["loadVector"])
        ]
    }


def plane_for_selection(parsed, selection_ref):
    face = face_for_selection(parsed["study"], parsed["displayModel"], selection_ref)
    if not face:
        raise UserFacingSolveError(f"Structured block selection {selection_ref} could not be matched to a display face.", 422)
    normal = face.get("normal") if isinstance(face, dict) else None
    center = face.get("center") if isinstance(face, dict) else None
    dimensions = parsed["dimensions"]
    if is_vec3(normal) and vector_length(normal) > 1e-9:
        axis_index = max(range(3), key=lambda index: abs(normal[index]))
        side = "max" if normal[axis_index] >= 0 else "min"
        return {"axis": AXES[axis_index], "side": side, "coordinate": dimensions[AXES[axis_index]] if side == "max" else 0.0}
    if is_vec3(center):
        candidates = []
        for index, axis in enumerate(AXES):
            candidates.append((abs(center[index]), axis, "min", 0.0))
            candidates.append((abs(center[index] - dimensions[axis]), axis, "max", dimensions[axis]))
        _, axis, side, coordinate = min(candidates, key=lambda item: item[0])
        return {"axis": axis, "side": side, "coordinate": coordinate}
    raise UserFacingSolveError(f"Structured block selection {selection_ref} did not include a face center or normal.", 422)


def face_for_selection(study, display_model, selection_ref):
    faces = display_model.get("faces") if isinstance(display_model.get("faces"), list) else []
    face_by_id = {face.get("id"): face for face in faces if isinstance(face, dict) and isinstance(face.get("id"), str)}
    if selection_ref in face_by_id:
        return face_by_id[selection_ref]
    selections = study.get("namedSelections") if isinstance(study.get("namedSelections"), list) else []
    for selection in selections:
        if not isinstance(selection, dict) or selection.get("id") != selection_ref:
            continue
        refs = selection.get("geometryRefs") if isinstance(selection.get("geometryRefs"), list) else []
        for ref in refs:
            if isinstance(ref, dict) and ref.get("entityId") in face_by_id:
                return face_by_id[ref.get("entityId")]
    return None


def node_ids_on_plane(mesh, plane):
    axis_index = AXES.index(plane["axis"])
    coordinate = plane["coordinate"]
    return [
        node["id"]
        for node in mesh["nodes"]
        if abs(node["coordinates"][axis_index] - coordinate) <= 1e-9
    ]


def distribute_total_force_to_nodes(mesh, load_node_ids, total_force):
    load_node_set = set(load_node_ids)
    load_nodes = [node for node in mesh["nodes"] if node["id"] in load_node_set]
    if not load_nodes:
        raise UserFacingSolveError("Cannot distribute load over an empty node set.", 422)
    plane_axis = constant_axis_for_nodes(load_nodes)
    in_plane_axes = [index for index in range(3) if index != plane_axis]
    minima = {axis: min(node["coordinates"][axis] for node in load_nodes) for axis in in_plane_axes}
    maxima = {axis: max(node["coordinates"][axis] for node in load_nodes) for axis in in_plane_axes}
    weighted = []
    for node in load_nodes:
        edge_count = sum(
            1
            for axis in in_plane_axes
            if abs(node["coordinates"][axis] - minima[axis]) <= 1e-9 or abs(node["coordinates"][axis] - maxima[axis]) <= 1e-9
        )
        weight = 1 if edge_count == 2 else 2 if edge_count == 1 else 4
        weighted.append((node, weight))
    total_weight = sum(weight for _, weight in weighted)
    return [
        {
            "nodeId": node["id"],
            "components": [component * weight / total_weight for component in total_force]
        }
        for node, weight in weighted
    ]


def constant_axis_for_nodes(nodes):
    ranges = []
    for axis in range(3):
        values = [node["coordinates"][axis] for node in nodes]
        ranges.append(max(values) - min(values))
    return min(range(3), key=lambda axis: ranges[axis])


def write_calculix_input_deck(parsed, mesh, boundaries, nodal_loads):
    material = parsed["material"]
    return "\n".join([
        "*HEADING",
        "OpenCAE structured block CalculiX solve",
        "** Units: mm, N, s, MPa. Density units: tonne/mm^3.",
        "*NODE",
        *[f'{node["id"]}, {node["coordinates"][0]:.12g}, {node["coordinates"][1]:.12g}, {node["coordinates"][2]:.12g}' for node in mesh["nodes"]],
        "*ELEMENT, TYPE=C3D8, ELSET=SOLID",
        *[f'{element["id"]}, {", ".join(str(node_id) for node_id in element["nodeIds"])}' for element in mesh["elements"]],
        "*NSET, NSET=NALL",
        *format_id_lines([node["id"] for node in mesh["nodes"]]),
        "*NSET, NSET=FIXED",
        *format_id_lines(boundaries["fixedNodeIds"]),
        "*NSET, NSET=LOADFACE",
        *format_id_lines(boundaries["loadNodeIds"]),
        "*ELSET, ELSET=SOLID",
        *format_id_lines([element["id"] for element in mesh["elements"]]),
        "*MATERIAL, NAME=OPENCAE_MATERIAL",
        "*ELASTIC",
        f'{material["youngsModulusMpa"]:.12g}, {material["poissonRatio"]:.12g}',
        "*DENSITY",
        f'{material["densityTonnePerMm3"]:.12g}',
        "*SOLID SECTION, ELSET=SOLID, MATERIAL=OPENCAE_MATERIAL",
        "*STEP, NLGEOM=NO",
        "*STATIC",
        "*BOUNDARY",
        "FIXED, 1, 3",
        "*CLOAD",
        *format_cload_lines(nodal_loads),
        "*NODE PRINT, NSET=NALL",
        "U",
        "*NODE PRINT, NSET=FIXED",
        "RF",
        "*EL PRINT, ELSET=SOLID",
        "S",
        "*NODE FILE, NSET=NALL",
        "U",
        "*EL FILE, ELSET=SOLID",
        "S",
        "*END STEP",
        ""
    ])


def format_id_lines(ids):
    sorted_ids = sorted(ids)
    return [", ".join(str(item) for item in sorted_ids[index:index + 16]) for index in range(0, len(sorted_ids), 16)]


def format_cload_lines(nodal_loads):
    lines = []
    for load in nodal_loads:
        for axis, dof in enumerate(DOFS):
            component = load["components"][axis]
            if abs(component) > 1e-14:
                lines.append(f'{load["nodeId"]}, {dof}, {component:.12g}')
    return lines


def parse_calculix_results(workdir, parsed, mesh, boundaries, input_deck, solver_output):
    parsed_files = parse_calculix_result_files(workdir, parsed["runId"], mesh)
    if is_parsed_calculix_status(parsed_files["status"]):
        return response_from_parsed_dat(parsed, mesh, boundaries, input_deck, solver_output, parsed_files)
    return {
        "artifacts": artifacts_for_failure(input_deck, solver_output, parsed_files["status"], mesh, boundaries, parsed_files["files"])
    }


def is_parsed_calculix_status(status):
    return isinstance(status, str) and status.lower().startswith("parsed-calculix")


def run_ccx_if_available(workdir, deck_path):
    if not shutil.which("ccx"):
        return {"log": "CalculiX executable unavailable; input deck produced for debugging only.", "returnCode": None}
    result = subprocess.run(["ccx", deck_path.stem], cwd=workdir, capture_output=True, text=True, timeout=45, check=False)
    output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
    log = output.strip() or f"CalculiX exited with code {result.returncode}."
    result_files = sorted(path.name for path in workdir.glob(f"{deck_path.stem}.*") if path.suffix.lower() in {".frd", ".dat", ".sta"})
    if result.returncode == 0 and result_files:
        log = f"{log}\nDetected CalculiX result files: {', '.join(result_files)}. FRD/DAT extraction is required before publishing result fields."
    elif result.returncode == 0:
        log = f"{log}\nCalculiX completed but no FRD/DAT result files were produced."
    return {"log": log, "returnCode": result.returncode}


def parse_calculix_result_files(workdir, run_id):
    files = sorted(path.name for path in workdir.glob("*") if path.suffix.lower() in {".frd", ".dat", ".sta"})
    dat_files = [workdir / name for name in files if name.endswith(".dat")]
    for dat_path in dat_files:
        parsed = parse_dat_result(dat_path.read_text(errors="ignore"))
        if parsed["displacements"] and parsed["stresses"]:
            has_frd = any(name.endswith(".frd") for name in files)
            return {
                **parsed,
                "available": True,
                "files": files,
                "status": "parsed-calculix-dat",
                "resultSource": "parsed_frd_dat" if has_frd else "parsed_dat"
            }
    return {
        "available": any(name.endswith((".frd", ".dat")) for name in files),
        "files": files,
        "displacements": {},
        "reactions": {},
        "stresses": [],
        "status": f"unparsed-calculix-output-for-{run_id}",
        "resultSource": "unknown"
    }


def parse_dat_result(text, mesh=None):
    displacements = {}
    reactions = {}
    stresses = []
    section = None
    for line in text.splitlines():
        lowered = line.lower()
        if "displacements" in lowered:
            section = "u"
            continue
        if "stresses" in lowered:
            section = "s"
            continue
        if "forces" in lowered or "reaction" in lowered:
            section = "rf"
            continue
        values = floats_from_line(line)
        if section == "u" and len(values) >= 4 and integer_like(values[0]):
            displacements[int(round(values[0]))] = values[-3:]
        elif section == "rf" and len(values) >= 4 and integer_like(values[0]):
            reactions[int(round(values[0]))] = values[-3:]
        elif section == "s" and len(values) >= 7 and integer_like(values[0]):
            element_id = int(round(values[0]))
            components = values[-6:]
            stresses.append({
                "elementId": element_id,
                "components": components,
                "vonMises": von_mises(components),
                "point": element_centroid(mesh, element_id) if mesh is not None else None
            })
    return {"displacements": displacements, "reactions": reactions, "stresses": stresses}


def response_from_parsed_dat(parsed, mesh, boundaries, input_deck, solver_output, parsed_dat):
    run_id = parsed["runId"]
    material = parsed["material"]
    displacement_samples = []
    for node in mesh["nodes"]:
        vector = parsed_dat["displacements"].get(node["id"])
        if vector is None:
            continue
        displacement_samples.append({
            "point": list(node["coordinates"]),
            "normal": [0.0, 0.0, 1.0],
            "value": vector_length(vector),
            "vector": vector,
            "nodeId": f'N{node["id"]}',
            "source": "calculix-dat"
        })
    stress_samples = [
        {
            "point": stress["point"],
            "normal": [0.0, 0.0, 1.0],
            "value": stress["vonMises"],
            "elementId": f'E{stress["elementId"]}',
            "source": "calculix-dat",
            "vonMisesStressPa": stress["vonMises"] * 1_000_000.0
        }
        for stress in parsed_dat["stresses"]
    ]
    stress_values = [sample["value"] for sample in stress_samples]
    displacement_values = [sample["value"] for sample in displacement_samples]
    max_stress = max(stress_values)
    max_displacement = max(displacement_values)
    reaction_force = reaction_force_magnitude(parsed_dat["reactions"], boundaries["fixedNodeIds"])
    if reaction_force <= 0:
        reaction_force = vector_length(parsed["loadVector"])
    safety_factor = material["yieldMpa"] / max(max_stress, 0.001)
    provenance = {
        "kind": "calculix_fea",
            "solver": "calculix-ccx",
            "solverVersion": command_version(["ccx", "-v"]),
            "meshSource": "structured_block",
            "resultSource": parsed_dat["resultSource"],
            "units": "mm-N-s-MPa"
        }
    fields = [
        field_from_samples(run_id, "stress", "element", "MPa", stress_values, stress_samples, provenance),
        field_from_samples(run_id, "displacement", "node", "mm", displacement_values, displacement_samples, provenance),
        field_from_samples(
            run_id,
            "safety_factor",
            "element",
            "",
            [material["yieldMpa"] / max(value, 0.001) for value in stress_values],
            [
                {
                    "point": sample["point"],
                    "normal": sample["normal"],
                    "value": material["yieldMpa"] / max(sample["value"], 0.001),
                    "elementId": sample["elementId"],
                    "source": "calculix-dat"
                }
                for sample in stress_samples
            ],
            provenance
        )
    ]
    summary = {
        "maxStress": max_stress,
        "maxStressUnits": "MPa",
        "maxDisplacement": max_displacement,
        "maxDisplacementUnits": "mm",
        "safetyFactor": safety_factor,
        "reactionForce": reaction_force,
        "reactionForceUnits": "N",
        "failureAssessment": {
            "status": "fail" if safety_factor < 1 else "pass",
            "title": "CalculiX FEA",
            "message": "Cloud FEA results were parsed from CalculiX DAT output."
        },
        "provenance": provenance
    }
    return {
        "summary": summary,
        "fields": fields,
        "diagnostics": boundaries["diagnostics"],
        "artifacts": {
            "inputDeck": input_deck,
            "solverLog": solver_output["log"],
            "solverResultFiles": parsed_dat["files"],
            "solverResultParser": parsed_dat["status"],
            "meshSummary": mesh_summary(mesh, boundaries),
            "solverMaterial": material
        }
    }


def field_from_samples(run_id, field_type, location, units, values, samples, provenance):
    return {
        "id": f"field-{run_id}-{field_type}-0",
        "runId": run_id,
        "type": field_type,
        "location": location,
        "values": values,
        "min": min(values) if values else 0.0,
        "max": max(values) if values else 0.0,
        "units": units,
        "samples": samples,
        "provenance": provenance
    }


def artifacts_for_failure(input_deck, solver_output, parser_status, mesh, boundaries, files=None):
    return {
        "inputDeck": input_deck,
        "solverLog": solver_output["log"],
        "solverResultFiles": files or [],
        "solverResultParser": parser_status,
        "meshSummary": mesh_summary(mesh, boundaries)
    }


def mesh_summary(mesh, boundaries):
    return {
        "nodes": len(mesh["nodes"]),
        "elements": len(mesh["elements"]),
        "source": "structured_block",
        "units": "mm-N-s-MPa",
        "density": mesh["density"],
        "fixed": {
            "plane": boundaries["fixedPlane"],
            "nodeCount": len(boundaries["fixedNodeIds"])
        },
        "load": {
            "plane": boundaries["loadPlane"],
            "nodeCount": len(boundaries["loadNodeIds"])
        }
    }


def boundary_diagnostic(diagnostic_id, label, plane, node_count, total_force=None):
    force_text = f", total force {format_vector(total_force)} N" if total_force else ""
    return {
        "id": diagnostic_id,
        "severity": "info",
        "source": "solver",
        "message": f'{label} resolved to {plane["axis"]}-{plane["side"]} block plane with {node_count} nodes{force_text}.',
        "suggestedActions": []
    }


def format_vector(vector):
    return "[" + ", ".join(f"{component:.6g}" for component in vector) + "]"


def floats_from_line(line):
    values = []
    for token in re.findall(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?", line):
        try:
            values.append(float(token.replace("D", "E").replace("d", "E")))
        except ValueError:
            pass
    return values


def integer_like(value):
    return abs(value - round(value)) < 1e-9


def von_mises(components):
    sx, sy, sz, sxy, sxz, syz = components
    return math.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3.0 * (sxy ** 2 + sxz ** 2 + syz ** 2))


def element_centroid(mesh, element_id):
    if element_id <= 0 or element_id > len(mesh["elements"]):
        return [0.0, 0.0, 0.0]
    element = mesh["elements"][element_id - 1]
    by_id = {node["id"]: node for node in mesh["nodes"]}
    coords = [by_id[node_id]["coordinates"] for node_id in element["nodeIds"]]
    return [sum(point[axis] for point in coords) / len(coords) for axis in range(3)]


def reaction_force_magnitude(reactions, fixed_node_ids):
    components = [0.0, 0.0, 0.0]
    for node_id in fixed_node_ids:
        reaction = reactions.get(node_id)
        if not reaction:
            continue
        for axis in range(3):
            components[axis] += reaction[axis]
    return vector_length(components)


def first_record(value):
    if not isinstance(value, list):
        return None
    for item in value:
        if isinstance(item, dict):
            return item
    return None


def unit_vector(value):
    if not is_vec3(value):
        raise UserFacingSolveError("Structured block force load requires a finite 3D direction vector.", 422)
    magnitude = vector_length(value)
    if magnitude <= 1e-12:
        raise UserFacingSolveError("Structured block force load direction cannot be zero.", 422)
    return [component / magnitude for component in value]


def is_vec3(value):
    return isinstance(value, list) and len(value) == 3 and all(isinstance(component, (int, float)) and math.isfinite(component) for component in value)


def vector_length(vector):
    return math.sqrt(sum(component * component for component in vector))


def is_positive_finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value) and value > 0


def material_properties(payload):
    solver_material = payload.get("solverMaterial")
    if not isinstance(solver_material, dict):
        raise UserFacingSolveError(INVALID_SOLVER_MATERIAL_ERROR, 422)
    material = {
        "id": str(solver_material.get("id") or "assigned-material"),
        "name": str(solver_material.get("name") or "Assigned material"),
        "category": str(solver_material.get("category") or "unknown"),
        "youngsModulusMpa": required_positive_number(solver_material, "youngsModulusMpa"),
        "poissonRatio": required_poisson_ratio(solver_material),
        "densityTonnePerMm3": required_positive_number(solver_material, "densityTonnePerMm3"),
        "yieldMpa": required_positive_number(solver_material, "yieldMpa")
    }
    return material


def required_positive_number(record, key):
    value = record.get(key)
    if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise UserFacingSolveError(INVALID_SOLVER_MATERIAL_ERROR, 422)
    return float(value)


def required_poisson_ratio(record):
    value = record.get("poissonRatio")
    if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 or value >= 0.5:
        raise UserFacingSolveError(INVALID_SOLVER_MATERIAL_ERROR, 422)
    return float(value)


def command_version(command):
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=3)
        return (result.stdout or result.stderr).strip().splitlines()[0]
    except Exception:
        return "unavailable"


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
