from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import base64
import binascii
import json
import math
import re
import shutil
import subprocess
import tempfile
import traceback


UNPARSED_RESULTS_ERROR = "CalculiX output was not parsed into real result fields; refusing to publish generated fallback results."
INVALID_SOLVER_MATERIAL_ERROR = "Cloud FEA requires a valid solverMaterial with positive finite CalculiX material properties."
UNSUPPORTED_BLOCK_ERROR = "Cloud FEA currently supports only block-like single-body models with positive millimeter dimensions."
CCX_UNAVAILABLE_ERROR = "CalculiX executable unavailable; refusing to publish Cloud FEA results without a real solver run."
GMSH_UNAVAILABLE_ERROR = "Gmsh executable unavailable; refusing to mesh uploaded geometry for Cloud FEA."
UNSUPPORTED_UPLOADED_GEOMETRY_ERROR = "Cloud FEA uploaded geometry support requires STEP, STL, or OBJ model bytes and confident face mapping."
AXES = ("x", "y", "z")
DOFS = (1, 2, 3)
FIDELITY_MESH_DENSITY = {
    "standard": {"nx": 20, "ny": 6, "nz": 4},
    "detailed": {"nx": 40, "ny": 10, "nz": 6},
    "ultra": {"nx": 80, "ny": 16, "nz": 10}
}
MAX_RESULT_VALUES = 25_000
MAX_RESULT_SAMPLES = 25_000
MAX_FIELD_SAMPLES_PER_TYPE = {
    "stress": 20_000,
    "displacement": 15_000,
    "safety_factor": 20_000,
}
MAX_INPUT_DECK_ARTIFACT_BYTES = 1024 * 1024
MAX_SOLVER_LOG_ARTIFACT_BYTES = 256 * 1024


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
            self._json(500, {
                "error": f"CalculiX adapter failed: {error}",
                "artifacts": {
                    "solverResultParser": "python-exception",
                    "solverLog": traceback.format_exc()
                }
            })

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
    if parsed.get("geometry"):
        return solve_uploaded_geometry(parsed)
    return solve_structured_block(parsed)


def solve_structured_block(parsed):
    run_id = parsed["runId"]
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


def solve_uploaded_geometry(parsed):
    run_id = parsed["runId"]
    with tempfile.TemporaryDirectory(prefix=f"{run_id}-") as tmp:
        workdir = Path(tmp)
        staged_geometry = stage_uploaded_geometry(workdir, parsed["geometry"])
        if not shutil.which("gmsh"):
            raise UserFacingSolveError(GMSH_UNAVAILABLE_ERROR, 503, {
                "artifacts": uploaded_geometry_failure_artifacts(parsed, "gmsh-unavailable", "", {"log": GMSH_UNAVAILABLE_ERROR})
            })
        gmsh_output = run_gmsh_if_available(workdir, staged_geometry, parsed)
        if gmsh_output["returnCode"] != 0:
            raise UserFacingSolveError("Gmsh failed to generate a usable 3D mesh for uploaded geometry.", 422, {
                "artifacts": uploaded_geometry_failure_artifacts(parsed, "gmsh-failed", "", {"log": gmsh_output["log"]})
            })
        mesh_path = workdir / "opencae_mesh.msh"
        if not mesh_path.exists():
            raise UserFacingSolveError("Gmsh completed but did not produce a mesh file for uploaded geometry.", 422, {
                "artifacts": uploaded_geometry_failure_artifacts(parsed, "gmsh-mesh-missing", "", {"log": gmsh_output["log"]})
            })
        mesh = parse_gmsh_msh(mesh_path.read_text(errors="ignore"))
        boundaries = select_uploaded_geometry_boundaries(parsed, mesh)
        nodal_loads = distribute_total_force_over_facets(mesh, boundaries["loadFacetIds"], parsed["loadVector"])
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
        raise UserFacingSolveError("Cloud FEA currently supports static stress studies only.", 422)
    material = material_properties(payload)
    geometry = uploaded_geometry_payload(payload)
    dimensions = None if geometry else resolve_block_dimensions(payload)
    load = first_record(study.get("loads"))
    constraint = first_record(study.get("constraints"))
    if not load or load.get("type") != "force":
        raise UserFacingSolveError("Cloud FEA requires a force load.", 422)
    if not constraint:
        raise UserFacingSolveError("Cloud FEA requires a fixed support.", 422)
    load_value = required_positive_number(load.get("parameters") if isinstance(load.get("parameters"), dict) else {}, "value")
    load_direction = unit_vector((load.get("parameters") or {}).get("direction"))
    parsed = {
        "runId": run_id,
        "study": study,
        "displayModel": payload.get("displayModel") if isinstance(payload.get("displayModel"), dict) else {},
        "material": material,
        "dimensions": dimensions,
        "meshDensity": mesh_density_for(payload.get("fidelity")),
        "load": load,
        "constraint": constraint,
        "loadVector": [load_value * component for component in load_direction],
        "loadMagnitude": load_value,
        "geometry": geometry
    }
    return parsed


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


def uploaded_geometry_payload(payload):
    geometry = payload.get("geometry")
    if not isinstance(geometry, dict):
        return None
    geometry_format = str(geometry.get("format") or "").lower()
    filename = str(geometry.get("filename") or f"uploaded.{geometry_format}")
    content_base64 = geometry.get("contentBase64")
    if geometry_format == "stp":
        geometry_format = "step"
    if geometry_format not in {"step", "stl", "obj"} or not isinstance(content_base64, str) or not content_base64.strip():
        raise UserFacingSolveError(UNSUPPORTED_UPLOADED_GEOMETRY_ERROR, 422)
    extension = ".stp" if geometry_format == "step" and filename.lower().endswith(".stp") else f".{geometry_format}"
    safe_filename = re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(filename).name) or f"uploaded{extension}"
    if Path(safe_filename).suffix.lower() not in {".step", ".stp", ".stl", ".obj"}:
        safe_filename = f"{safe_filename}{extension}"
    return {
        "format": geometry_format,
        "filename": safe_filename,
        "contentBase64": content_base64
    }


def stage_uploaded_geometry(workdir, geometry):
    try:
        content = base64.b64decode(geometry["contentBase64"], validate=True)
    except (binascii.Error, ValueError) as error:
        raise UserFacingSolveError(f"{UNSUPPORTED_UPLOADED_GEOMETRY_ERROR} Invalid base64 geometry content.", 422) from error
    if not content:
        raise UserFacingSolveError(UNSUPPORTED_UPLOADED_GEOMETRY_ERROR, 422)
    geometry_path = workdir / geometry["filename"]
    geometry_path.write_bytes(content)
    return geometry_path


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
    return {"nodes": nodes, "elements": elements, "dimensions": dimensions, "density": {"nx": nx, "ny": ny, "nz": nz}, "source": "structured_block", "elementType": "C3D8"}


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


def distribute_total_force_over_facets(mesh, load_facet_ids, total_force):
    facets_by_id = {facet["id"]: facet for facet in mesh.get("boundaryFacets", [])}
    nodal_weights = {}
    total_area = 0.0
    for facet_id in load_facet_ids:
        facet = facets_by_id.get(facet_id)
        if not facet:
            continue
        area = facet["area"]
        if area <= 0:
            continue
        share = area / len(facet["nodeIds"])
        for node_id in facet["nodeIds"]:
            nodal_weights[node_id] = nodal_weights.get(node_id, 0.0) + share
        total_area += area
    if total_area <= 0 or not nodal_weights:
        raise UserFacingSolveError("Cannot distribute uploaded-geometry load over an empty mapped face.", 422)
    return [
        {
            "nodeId": node_id,
            "components": [component * weight / total_area for component in total_force]
        }
        for node_id, weight in sorted(nodal_weights.items())
    ]


def run_gmsh_if_available(workdir, geometry_path, parsed):
    if not shutil.which("gmsh"):
        return {"log": GMSH_UNAVAILABLE_ERROR, "returnCode": None}
    mesh_size = gmsh_mesh_size(parsed)
    geo_path = workdir / "opencae_mesh.geo"
    mesh_path = workdir / "opencae_mesh.msh"
    geo_path.write_text(gmsh_geo_script(geometry_path.name, parsed["geometry"]["format"], mesh_size))
    result = subprocess.run(["gmsh", str(geo_path), "-3", "-format", "msh2", "-o", str(mesh_path)], cwd=workdir, capture_output=True, text=True, timeout=90, check=False)
    output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
    log = output.strip() or f"Gmsh exited with code {result.returncode}."
    return {"log": log, "returnCode": result.returncode}


def gmsh_mesh_size(parsed):
    display_model = parsed.get("displayModel") if isinstance(parsed.get("displayModel"), dict) else {}
    dimensions = display_model.get("dimensions") if isinstance(display_model.get("dimensions"), dict) else {}
    values = [dimensions.get(axis) for axis in AXES]
    spans = [float(value) for value in values if is_positive_finite(value)]
    span = max(spans) if spans else 100.0
    fidelity = parsed["meshDensity"]
    divisions = max(fidelity["nx"], fidelity["ny"], fidelity["nz"])
    return max(span / divisions, span * 0.01, 0.25)


def gmsh_geo_script(filename, geometry_format, mesh_size):
    escaped = filename.replace("\\", "\\\\").replace('"', '\\"')
    common = [
        'SetFactory("OpenCASCADE");',
        f'Merge "{escaped}";',
        f"Mesh.CharacteristicLengthMin = {mesh_size:.12g};",
        f"Mesh.CharacteristicLengthMax = {mesh_size:.12g};",
        "Mesh.ElementOrder = 1;"
    ]
    if geometry_format in {"stl", "obj"}:
        common.extend([
            "ClassifySurfaces{40*Pi/180, 1, 1, Pi};",
            "CreateGeometry;",
            "Surface Loop(1) = Surface{:};",
            "Volume(1) = {1};"
        ])
    common.extend([
        'Physical Volume("SOLID") = Volume{:};',
        "Mesh 3;",
        'Save "opencae_mesh.msh";',
        ""
    ])
    return "\n".join(common)


def parse_gmsh_msh(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    nodes = []
    node_lookup = {}
    elements = []
    boundary_facets = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if line == "$Nodes":
            count = int(lines[index + 1])
            for offset in range(count):
                parts = lines[index + 2 + offset].split()
                node = {"id": int(parts[0]), "coordinates": (float(parts[1]), float(parts[2]), float(parts[3]))}
                nodes.append(node)
                node_lookup[node["id"]] = node
            index += count + 3
            continue
        if line == "$Elements":
            count = int(lines[index + 1])
            for offset in range(count):
                parts = lines[index + 2 + offset].split()
                element_id = int(parts[0])
                gmsh_type = int(parts[1])
                tag_count = int(parts[2])
                node_ids = [int(value) for value in parts[3 + tag_count:]]
                if gmsh_type == 2:
                    boundary_facets.append(boundary_facet(element_id, node_ids[:3], node_lookup))
                elif gmsh_type == 4:
                    elements.append({"id": element_id, "nodeIds": node_ids[:4], "type": "C3D4"})
                elif gmsh_type == 11:
                    elements.append({"id": element_id, "nodeIds": node_ids[:10], "type": "C3D10"})
            index += count + 3
            continue
        index += 1
    if not nodes or not elements:
        raise UserFacingSolveError("Gmsh mesh did not contain nodes and supported tetrahedral volume elements.", 422)
    element_types = {element["type"] for element in elements}
    if len(element_types) != 1:
        raise UserFacingSolveError("Gmsh mesh mixed tetrahedral element orders; refusing ambiguous CalculiX deck generation.", 422)
    return {
        "nodes": sorted(nodes, key=lambda node: node["id"]),
        "elements": sorted(elements, key=lambda element: element["id"]),
        "boundaryFacets": sorted(boundary_facets, key=lambda facet: facet["id"]),
        "source": "gmsh_uploaded_geometry",
        "elementType": next(iter(element_types)),
        "density": {}
    }


def boundary_facet(facet_id, node_ids, node_lookup):
    points = [node_lookup[node_id]["coordinates"] for node_id in node_ids]
    normal_vector = cross(subtract(points[1], points[0]), subtract(points[2], points[0]))
    area = 0.5 * vector_length(normal_vector)
    normal = normalize_vector(normal_vector)
    center = tuple(sum(point[axis] for point in points) / len(points) for axis in range(3))
    return {
        "id": facet_id,
        "nodeIds": node_ids,
        "center": center,
        "normal": normal,
        "area": area,
        "bbox": {
            "min": tuple(min(point[axis] for point in points) for axis in range(3)),
            "max": tuple(max(point[axis] for point in points) for axis in range(3))
        }
    }


def select_uploaded_geometry_boundaries(parsed, mesh):
    fixed = uploaded_face_mapping(parsed, mesh, parsed["constraint"].get("selectionRef"), "Fixed support")
    load = uploaded_face_mapping(parsed, mesh, parsed["load"].get("selectionRef"), "Applied load")
    fixed_nodes = sorted({node_id for facet in fixed["facets"] for node_id in facet["nodeIds"]})
    load_nodes = sorted({node_id for facet in load["facets"] for node_id in facet["nodeIds"]})
    if not fixed_nodes or not load_nodes or not set(fixed_nodes).isdisjoint(load_nodes):
        raise uploaded_face_mapping_error("Mapped uploaded-geometry support and load faces must be non-empty and disjoint.", parsed, mesh)
    return {
        "fixedNodeIds": fixed_nodes,
        "loadNodeIds": load_nodes,
        "fixedFacetIds": [facet["id"] for facet in fixed["facets"]],
        "loadFacetIds": [facet["id"] for facet in load["facets"]],
        "fixedPlane": fixed["plane"],
        "loadPlane": load["plane"],
        "diagnostics": [
            uploaded_boundary_diagnostic("cloud-fea-uploaded-fixed-face", "Fixed support", fixed, len(fixed_nodes)),
            uploaded_boundary_diagnostic("cloud-fea-uploaded-load-face", "Applied load", load, len(load_nodes), parsed["loadVector"])
        ]
    }


def uploaded_face_mapping(parsed, mesh, selection_ref, label):
    face = face_for_selection(parsed["study"], parsed["displayModel"], selection_ref)
    if not face or not is_vec3(face.get("center")) or not is_vec3(face.get("normal")):
        raise uploaded_face_mapping_error(f"{label} selection {selection_ref} could not be mapped confidently to uploaded geometry; missing face center or normal.", parsed, mesh)
    target_center = face["center"]
    target_normal = normalize_vector(face["normal"])
    target_bbox = face_bbox(face)
    target_area = face_area(face)
    if vector_length(target_normal) <= 1e-12:
        raise uploaded_face_mapping_error(f"{label} selection {selection_ref} has a zero normal.", parsed, mesh)
    spans = mesh_spans(mesh)
    tolerance = max(max(spans) * 0.02, 1e-5)
    plane_coordinate = dot(target_center, target_normal)
    candidates = []
    duplicate_keys = set()
    seen_keys = set()
    for facet in mesh.get("boundaryFacets", []):
        normal_alignment = dot(facet["normal"], target_normal)
        if normal_alignment < 0.70:
            continue
        plane_distance = abs(dot(facet["center"], target_normal) - plane_coordinate)
        if plane_distance > tolerance:
            continue
        key = (
            round(facet["center"][0], 8),
            round(facet["center"][1], 8),
            round(facet["center"][2], 8),
            round(facet["normal"][0], 8),
            round(facet["normal"][1], 8),
            round(facet["normal"][2], 8)
        )
        if key in seen_keys:
            duplicate_keys.add(key)
        seen_keys.add(key)
        center_distance = vector_length(subtract(facet["center"], target_center))
        bbox_score = bbox_overlap_score(target_bbox, facet["bbox"]) if target_bbox else 0.0
        area_penalty = area_mismatch(target_area, facet["area"]) if target_area else 0.0
        score = normal_alignment + bbox_score - area_penalty - (center_distance / max(max(spans), 1e-9)) - (plane_distance / tolerance)
        candidates.append((score, facet))
    if not candidates or duplicate_keys:
        raise uploaded_face_mapping_error(f"{label} selection {selection_ref} could not be mapped confidently to uploaded geometry.", parsed, mesh)
    candidates.sort(key=lambda item: item[0], reverse=True)
    best_score = candidates[0][0]
    facets = [facet for score, facet in candidates if best_score - score <= 1.25]
    if not facets:
        raise uploaded_face_mapping_error(f"{label} selection {selection_ref} could not be mapped confidently to uploaded geometry.", parsed, mesh)
    return {
        "face": face,
        "facets": sorted(facets, key=lambda facet: facet["id"]),
        "plane": {"axis": dominant_axis(target_normal), "coordinate": plane_coordinate, "normal": target_normal},
        "score": best_score
    }


def uploaded_face_mapping_error(message, parsed, mesh):
    diagnostics = [{
        "id": "cloud-fea-uploaded-face-mapping-failed",
        "severity": "error",
        "source": "mesh",
        "message": message,
        "suggestedActions": ["Select clearer support and load faces on the uploaded model, or use the validated structured block workflow for benchmark cases."],
        "details": {
            "boundaryFacetCount": len(mesh.get("boundaryFacets", [])) if isinstance(mesh, dict) else 0,
            "displayFaceCount": len(parsed.get("displayModel", {}).get("faces", [])) if isinstance(parsed.get("displayModel"), dict) else 0
        }
    }]
    return UserFacingSolveError(message, 422, {"diagnostics": diagnostics})


def face_area(face):
    value = face.get("area") if isinstance(face, dict) else None
    return float(value) if is_positive_finite(value) else None


def face_bbox(face):
    for key in ("bbox", "boundingBox", "bounds"):
        value = face.get(key) if isinstance(face, dict) else None
        if not isinstance(value, dict):
            continue
        minimum = value.get("min")
        maximum = value.get("max")
        if is_vec3(minimum) and is_vec3(maximum):
            return {"min": minimum, "max": maximum}
    return None


def bbox_overlap_score(target, candidate):
    overlap_volume = 1.0
    target_volume = 1.0
    for axis in range(3):
        overlap = max(0.0, min(target["max"][axis], candidate["max"][axis]) - max(target["min"][axis], candidate["min"][axis]))
        target_span = max(target["max"][axis] - target["min"][axis], 1e-9)
        overlap_volume *= overlap
        target_volume *= target_span
    return overlap_volume / max(target_volume, 1e-9)


def area_mismatch(target_area, candidate_area):
    return abs(target_area - candidate_area) / max(target_area, candidate_area, 1e-9)


def write_calculix_input_deck(parsed, mesh, boundaries, nodal_loads):
    material = parsed["material"]
    element_type = mesh.get("elementType", "C3D8")
    return "\n".join([
        "*HEADING",
        f'OpenCAE {mesh.get("source", "structured_block")} CalculiX solve',
        "** Units: mm, N, s, MPa. Density units: tonne/mm^3.",
        "*NODE",
        *[f'{node["id"]}, {node["coordinates"][0]:.12g}, {node["coordinates"][1]:.12g}, {node["coordinates"][2]:.12g}' for node in mesh["nodes"]],
        f"*ELEMENT, TYPE={element_type}, ELSET=SOLID",
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
    parsed_files = parse_calculix_result_files(workdir, parsed["runId"], {
        "mesh": mesh,
        "boundaries": boundaries,
        "parsed": parsed
    })
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


def parse_calculix_result_files(workdir, run_id, context=None, *_, **__):
    context = context or {}
    if not isinstance(context, dict):
        context = {}
    mesh = context.get("mesh")
    if not (isinstance(mesh, dict) and isinstance(mesh.get("nodes"), list) and isinstance(mesh.get("elements"), list)):
        mesh = None
    files = sorted(path.name for path in workdir.glob("*") if path.suffix.lower() in {".frd", ".dat", ".sta"})
    dat_files = [workdir / name for name in files if name.endswith(".dat")]
    for dat_path in dat_files:
        parsed = parse_dat_result(dat_path.read_text(errors="ignore"), mesh)
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


def display_bounds_for_model(display_model, dimensions):
    faces = display_model.get("faces") if isinstance(display_model, dict) and isinstance(display_model.get("faces"), list) else []
    points = [face.get("center") for face in faces if isinstance(face, dict) and is_vec3(face.get("center"))]
    if len(points) < 2:
        return None
    mins = [min(point[index] for point in points) for index in range(3)]
    maxs = [max(point[index] for point in points) for index in range(3)]
    spans = [maxs[index] - mins[index] for index in range(3)]
    dimension_spans = [dimensions.get(axis) for axis in AXES] if isinstance(dimensions, dict) else []
    if len(dimension_spans) != 3:
        return None
    if not all(is_positive_finite(span) for span in spans):
        return None
    if not all(is_positive_finite(span) for span in dimension_spans):
        return None
    return {"min": mins, "max": maxs}


def solver_point_to_display(point_mm, dimensions, display_bounds):
    if display_bounds is None:
        return list(point_mm)
    mapped = []
    for axis_index, axis in enumerate(AXES):
        span = dimensions[axis]
        t = point_mm[axis_index] / span if span > 0 else 0.0
        lo = display_bounds["min"][axis_index]
        hi = display_bounds["max"][axis_index]
        mapped.append(lo + t * (hi - lo))
    return mapped


def solver_vector_to_display(vector_mm, dimensions, display_bounds):
    if display_bounds is None:
        return list(vector_mm)
    mapped = []
    for axis_index, axis in enumerate(AXES):
        solver_span = dimensions[axis]
        display_span = display_bounds["max"][axis_index] - display_bounds["min"][axis_index]
        scale = display_span / solver_span if solver_span > 0 else 1.0
        mapped.append(vector_mm[axis_index] * scale)
    return mapped


def response_from_parsed_dat(parsed, mesh, boundaries, input_deck, solver_output, parsed_dat):
    run_id = parsed["runId"]
    material = parsed["material"]
    structured_block = mesh.get("source", "structured_block") == "structured_block"
    display_bounds = display_bounds_for_model(parsed.get("displayModel", {}), parsed["dimensions"]) if structured_block else None
    sample_coordinate_space = "display_model" if display_bounds is not None else "mm"
    displacement_samples = []
    for node in mesh["nodes"]:
        vector = parsed_dat["displacements"].get(node["id"])
        if vector is None:
            continue
        displacement_samples.append({
            "point": solver_point_to_display(node["coordinates"], parsed["dimensions"], display_bounds),
            "normal": [0.0, 0.0, 1.0],
            "value": vector_length(vector),
            "vector": solver_vector_to_display(vector, parsed["dimensions"], display_bounds),
            "nodeId": f'N{node["id"]}',
            "source": "calculix-dat"
        })
    stress_samples = [
        {
            "point": solver_point_to_display(stress["point"], parsed["dimensions"], display_bounds),
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
            "meshSource": mesh.get("source", "structured_block"),
            "resultSource": parsed_dat["resultSource"],
            "units": "mm-N-s-MPa"
        }
    if display_bounds is not None:
        provenance["renderCoordinateSpace"] = "display_model"
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
    result = {
        "summary": summary,
        "fields": fields,
        "diagnostics": boundaries["diagnostics"],
        "artifacts": {
            **compact_text_artifact(input_deck, MAX_INPUT_DECK_ARTIFACT_BYTES, "inputDeckPreview"),
            **compact_text_artifact(solver_output["log"], MAX_SOLVER_LOG_ARTIFACT_BYTES, "solverLogPreview", keep_tail=True),
            "solverResultFiles": parsed_dat["files"],
            "solverResultParser": parsed_dat["status"],
            "meshSummary": mesh_summary(mesh, boundaries, sample_coordinate_space),
            "solverMaterial": material
        }
    }
    return compact_cloud_fea_result(result)


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


def decimate_sequence(items, max_count, key=None):
    if not isinstance(items, list) or max_count <= 0:
        return []
    if len(items) <= max_count:
        return list(items)
    last_index = len(items) - 1
    indexes = {0, last_index}
    if key is not None:
        keyed = []
        for index, item in enumerate(items):
            value = key(item)
            if isinstance(value, (int, float)) and math.isfinite(value):
                keyed.append((value, index))
        if keyed:
            indexes.add(min(keyed, key=lambda pair: pair[0])[1])
            indexes.add(max(keyed, key=lambda pair: pair[0])[1])
    slots = max(1, max_count)
    for slot in range(slots):
        if len(indexes) >= max_count:
            break
        index = round(slot * last_index / max(slots - 1, 1))
        indexes.add(index)
    return [items[index] for index in sorted(indexes)[:max_count]]


def compact_result_field(field, max_values, max_samples):
    compacted = dict(field)
    values = field.get("values") if isinstance(field.get("values"), list) else []
    samples = field.get("samples") if isinstance(field.get("samples"), list) else []
    compacted["values"] = decimate_sequence(values, max_values, key=lambda value: value)
    compacted["samples"] = decimate_sequence(samples, max_samples, key=lambda sample: sample.get("value") if isinstance(sample, dict) else None)
    return compacted


def compact_cloud_fea_result(result):
    fields = []
    compaction_fields = []
    original_stress_sample_count = 0
    returned_stress_sample_count = 0
    for field in result.get("fields", []):
        if not isinstance(field, dict):
            continue
        field_type = field.get("type")
        max_samples = MAX_FIELD_SAMPLES_PER_TYPE.get(field_type, MAX_RESULT_SAMPLES)
        values = field.get("values") if isinstance(field.get("values"), list) else []
        samples = field.get("samples") if isinstance(field.get("samples"), list) else []
        compacted = compact_result_field(field, MAX_RESULT_VALUES, max_samples)
        fields.append(compacted)
        returned_samples = compacted.get("samples") if isinstance(compacted.get("samples"), list) else []
        returned_values = compacted.get("values") if isinstance(compacted.get("values"), list) else []
        compaction_fields.append({
            "type": field_type,
            "originalValueCount": len(values),
            "returnedValueCount": len(returned_values),
            "originalSampleCount": len(samples),
            "returnedSampleCount": len(returned_samples),
            "maxSamples": max_samples,
        })
        if field_type == "stress":
            original_stress_sample_count += len(samples)
            returned_stress_sample_count += len(returned_samples)
    compacted_result = dict(result)
    compacted_result["fields"] = fields
    artifacts = dict(result.get("artifacts", {})) if isinstance(result.get("artifacts"), dict) else {}
    artifacts["resultCompaction"] = {
        "enabled": True,
        "maxFieldValues": MAX_RESULT_VALUES,
        "maxFieldSamples": MAX_RESULT_SAMPLES,
        "originalStressSampleCount": original_stress_sample_count,
        "returnedStressSampleCount": returned_stress_sample_count,
        "fields": compaction_fields,
    }
    compacted_result["artifacts"] = artifacts
    return compacted_result


def compact_text_artifact(text, max_bytes, preview_key_name, keep_tail=False):
    if not isinstance(text, str):
        text = ""
    base_key = preview_key_name[:-7] if preview_key_name.endswith("Preview") else preview_key_name
    encoded = text.encode("utf-8")
    metadata = {
        f"{base_key}Bytes": len(encoded),
        f"{base_key}Truncated": len(encoded) > max_bytes,
    }
    if len(encoded) <= max_bytes:
        metadata[base_key] = text
        return metadata
    chunk = encoded[-max_bytes:] if keep_tail else encoded[:max_bytes]
    metadata[preview_key_name] = chunk.decode("utf-8", errors="ignore")
    return metadata


def artifacts_for_failure(input_deck, solver_output, parser_status, mesh, boundaries, files=None):
    return {
        **compact_text_artifact(input_deck, MAX_INPUT_DECK_ARTIFACT_BYTES, "inputDeckPreview"),
        **compact_text_artifact(solver_output["log"], MAX_SOLVER_LOG_ARTIFACT_BYTES, "solverLogPreview", keep_tail=True),
        "solverResultFiles": files or [],
        "solverResultParser": parser_status,
        "meshSummary": mesh_summary(mesh, boundaries)
    }


def uploaded_geometry_failure_artifacts(parsed, parser_status, input_deck, solver_output):
    geometry = parsed.get("geometry") or {}
    return {
        **compact_text_artifact(input_deck, MAX_INPUT_DECK_ARTIFACT_BYTES, "inputDeckPreview"),
        **compact_text_artifact(solver_output["log"], MAX_SOLVER_LOG_ARTIFACT_BYTES, "solverLogPreview", keep_tail=True),
        "solverResultFiles": [],
        "solverResultParser": parser_status,
        "meshSummary": {
            "nodes": 0,
            "elements": 0,
            "source": "gmsh_uploaded_geometry",
            "units": "mm-N-s-MPa",
            "boundaryFacets": 0
        },
        "geometry": {
            "filename": geometry.get("filename"),
            "format": geometry.get("format")
        }
    }


def mesh_summary(mesh, boundaries, result_sample_coordinate_space=None):
    summary = {
        "nodes": len(mesh["nodes"]),
        "elements": len(mesh["elements"]),
        "source": mesh.get("source", "structured_block"),
        "units": "mm-N-s-MPa",
        "solverCoordinateSpace": "mm",
        "resultSampleCoordinateSpace": result_sample_coordinate_space or "mm",
        "density": mesh.get("density", {}),
        "fixed": {
            "plane": boundaries.get("fixedPlane"),
            "nodeCount": len(boundaries["fixedNodeIds"])
        },
        "load": {
            "plane": boundaries.get("loadPlane"),
            "nodeCount": len(boundaries["loadNodeIds"])
        }
    }
    if mesh.get("boundaryFacets") is not None:
        summary["boundaryFacets"] = len(mesh["boundaryFacets"])
        summary["elementType"] = mesh.get("elementType")
        summary["fixed"]["facetCount"] = len(boundaries.get("fixedFacetIds", []))
        summary["load"]["facetCount"] = len(boundaries.get("loadFacetIds", []))
    return summary


def boundary_diagnostic(diagnostic_id, label, plane, node_count, total_force=None):
    force_text = f", total force {format_vector(total_force)} N" if total_force else ""
    return {
        "id": diagnostic_id,
        "severity": "info",
        "source": "solver",
        "message": f'{label} resolved to {plane["axis"]}-{plane["side"]} block plane with {node_count} nodes{force_text}.',
        "suggestedActions": []
    }


def uploaded_boundary_diagnostic(diagnostic_id, label, mapping, node_count, total_force=None):
    force_text = f", total force {format_vector(total_force)} N" if total_force else ""
    face = mapping["face"]
    return {
        "id": diagnostic_id,
        "severity": "info",
        "source": "mesh",
        "message": f'{label} mapped uploaded face {face.get("id", "unknown")} to {len(mapping["facets"])} mesh boundary facets and {node_count} nodes{force_text}.',
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
        raise UserFacingSolveError("Cloud FEA force load requires a finite 3D direction vector.", 422)
    magnitude = vector_length(value)
    if magnitude <= 1e-12:
        raise UserFacingSolveError("Cloud FEA force load direction cannot be zero.", 422)
    return [component / magnitude for component in value]


def is_vec3(value):
    return isinstance(value, list) and len(value) == 3 and all(isinstance(component, (int, float)) and math.isfinite(component) for component in value)


def vector_length(vector):
    return math.sqrt(sum(component * component for component in vector))


def normalize_vector(vector):
    magnitude = vector_length(vector)
    if magnitude <= 1e-12:
        return [0.0, 0.0, 0.0]
    return [component / magnitude for component in vector]


def subtract(a, b):
    return [a[index] - b[index] for index in range(3)]


def dot(a, b):
    return sum(a[index] * b[index] for index in range(3))


def cross(a, b):
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
    ]


def dominant_axis(normal):
    axis_index = max(range(3), key=lambda index: abs(normal[index]))
    return AXES[axis_index]


def mesh_spans(mesh):
    nodes = mesh.get("nodes", [])
    if not nodes:
        return [1.0, 1.0, 1.0]
    spans = []
    for axis in range(3):
        values = [node["coordinates"][axis] for node in nodes]
        spans.append(max(values) - min(values))
    return [span if span > 0 else 1.0 for span in spans]


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
