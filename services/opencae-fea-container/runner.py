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
RUNNER_VERSION = "2026-05-03-load-normalization"
AXES = ("x", "y", "z")
DOFS = (1, 2, 3)
FIDELITY_MESH_DENSITY = {
    "standard": {"nx": 20, "ny": 6, "nz": 4},
    "detailed": {"nx": 40, "ny": 10, "nz": 6},
    "ultra": {"nx": 80, "ny": 16, "nz": 10}
}
MAX_RESULT_VALUES = 25_000
MAX_RESULT_SAMPLES = 25_000
MAX_DYNAMIC_FRAMES = 250
MAX_DYNAMIC_FIELD_VALUES_PER_FRAME = 10_000
MAX_DYNAMIC_FIELD_SAMPLES_PER_FRAME = 5_000
MAX_FIELD_SAMPLES_PER_TYPE = {
    "stress": 20_000,
    "displacement": 15_000,
    "safety_factor": 20_000,
    "velocity": 15_000,
    "acceleration": 15_000,
}
MAX_INPUT_DECK_ARTIFACT_BYTES = 1024 * 1024
MAX_SOLVER_LOG_ARTIFACT_BYTES = 256 * 1024
STANDARD_GRAVITY = 9.80665


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "solver": "calculix", "runnerVersion": RUNNER_VERSION, "ccx": command_version(["ccx", "-v"]), "gmsh": command_version(["gmsh", "--version"])})
            return
        self._json(404, {"error": "Not found"})

    def do_POST(self):
        phase = "request-routing"
        if self.path != "/solve":
            self._json(404, {"error": "Not found"})
            return
        try:
            phase = "request-body"
            length = int(self.headers.get("content-length", "0") or "0")
            body = self.rfile.read(length).decode("utf-8") if length else "{}"
            phase = "payload-parse"
            payload = json.loads(body)
            phase = "solve"
            result = solve(payload)
            phase = "response-serialization"
            self._json(200, result)
        except UserFacingSolveError as error:
            payload = {"error": str(error)}
            safe_payload = safe_json_value(error.payload)
            if isinstance(safe_payload, dict):
                payload.update(safe_payload)
            artifacts = payload.setdefault("artifacts", {})
            if isinstance(artifacts, dict):
                artifacts.setdefault("exceptionPhase", getattr(error, "exception_phase", phase))
                artifacts.setdefault("runnerVersion", RUNNER_VERSION)
            self._json(error.status, payload)
        except Exception as error:
            self._json(500, {
                "error": f"CalculiX adapter failed: {error}",
                "artifacts": {
                    "solverResultParser": "python-exception",
                    "solverLog": traceback.format_exc(),
                    "exceptionPhase": getattr(error, "exception_phase", phase),
                    "runnerVersion": RUNNER_VERSION
                }
            })

    def log_message(self, format, *args):
        return

    def _json(self, status, payload):
        response_status = status
        try:
            data = json.dumps(payload).encode("utf-8")
        except Exception as error:
            response_status = 500
            data = json.dumps({
                "error": f"Cloud FEA response failed to serialize: {error}",
                "artifacts": {
                    "solverResultParser": "python-response-serialization-exception",
                    "solverLog": traceback.format_exc(),
                    "exceptionPhase": "response-serialization",
                    "runnerVersion": RUNNER_VERSION
                }
            }).encode("utf-8")
        self.send_response(response_status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class UserFacingSolveError(Exception):
    def __init__(self, message, status=422, payload=None):
        super().__init__(message)
        self.status = status
        self.payload = payload or {}


def safe_json_value(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): safe_json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [safe_json_value(item) for item in value]
    return str(value)


def annotate_exception_phase(error, phase):
    if not hasattr(error, "exception_phase"):
        try:
            setattr(error, "exception_phase", phase)
        except Exception:
            pass
    return error


def solve(payload):
    try:
        parsed = parse_payload(payload)
    except Exception as error:
        raise annotate_exception_phase(error, "payload-parse")
    if parsed.get("geometry"):
        return solve_uploaded_geometry(parsed)
    return solve_structured_block(parsed)


def solve_structured_block(parsed):
    run_id = parsed["runId"]
    try:
        mesh = generate_structured_hex_mesh(parsed["dimensions"], parsed["meshDensity"])
        boundaries = select_boundary_nodes(parsed, mesh)
        nodal_loads = distribute_normalized_loads_to_nodes(parsed, mesh, boundaries)
    except Exception as error:
        raise annotate_exception_phase(error, "mesh-generation")

    with tempfile.TemporaryDirectory(prefix=f"{run_id}-") as tmp:
        workdir = Path(tmp)
        try:
            input_deck = write_calculix_input_deck(parsed, mesh, boundaries, nodal_loads)
            deck_path = workdir / "opencae_solve.inp"
            deck_path.write_text(input_deck)
        except Exception as error:
            raise annotate_exception_phase(error, "input-deck")
        try:
            solver_output = run_ccx_if_available(workdir, deck_path)
        except Exception as error:
            raise annotate_exception_phase(error, "solver-run")
        if solver_output["returnCode"] is None:
            raise UserFacingSolveError(CCX_UNAVAILABLE_ERROR, 503, {
                "artifacts": artifacts_for_failure(input_deck, solver_output, "ccx-unavailable", mesh, boundaries)
            })
        try:
            parsed_solver_results = parse_calculix_results(workdir, parsed, mesh, boundaries, input_deck, solver_output)
        except Exception as error:
            raise annotate_exception_phase(error, "result-parsing")

    if is_parsed_calculix_status(parsed_solver_results["artifacts"]["solverResultParser"]):
        return parsed_solver_results

    raise UserFacingSolveError(UNPARSED_RESULTS_ERROR, 422, {
        "artifacts": artifacts_for_failure(input_deck, solver_output, parsed_solver_results["artifacts"]["solverResultParser"], mesh, boundaries)
    })


def solve_uploaded_geometry(parsed):
    run_id = parsed["runId"]
    with tempfile.TemporaryDirectory(prefix=f"{run_id}-") as tmp:
        workdir = Path(tmp)
        try:
            staged_geometry = stage_uploaded_geometry(workdir, parsed["geometry"])
        except Exception as error:
            raise annotate_exception_phase(error, "geometry-stage")
        if not shutil.which("gmsh"):
            raise UserFacingSolveError(GMSH_UNAVAILABLE_ERROR, 503, {
                "artifacts": uploaded_geometry_failure_artifacts(parsed, "gmsh-unavailable", "", {"log": GMSH_UNAVAILABLE_ERROR})
            })
        try:
            gmsh_output = run_gmsh_if_available(workdir, staged_geometry, parsed)
        except Exception as error:
            raise annotate_exception_phase(error, "mesh-generation")
        if gmsh_output["returnCode"] != 0:
            raise UserFacingSolveError("Gmsh failed to generate a usable 3D mesh for uploaded geometry.", 422, {
                "artifacts": uploaded_geometry_failure_artifacts(parsed, "gmsh-failed", "", {"log": gmsh_output["log"]})
            })
        mesh_path = workdir / "opencae_mesh.msh"
        if not mesh_path.exists():
            raise UserFacingSolveError("Gmsh completed but did not produce a mesh file for uploaded geometry.", 422, {
                "artifacts": uploaded_geometry_failure_artifacts(parsed, "gmsh-mesh-missing", "", {"log": gmsh_output["log"]})
            })
        try:
            mesh = parse_gmsh_msh(mesh_path.read_text(errors="ignore"))
            boundaries = select_uploaded_geometry_boundaries(parsed, mesh)
            nodal_loads = distribute_normalized_loads_to_nodes(parsed, mesh, boundaries)
        except Exception as error:
            raise annotate_exception_phase(error, "mesh-generation")
        try:
            input_deck = write_calculix_input_deck(parsed, mesh, boundaries, nodal_loads)
            deck_path = workdir / "opencae_solve.inp"
            deck_path.write_text(input_deck)
        except Exception as error:
            raise annotate_exception_phase(error, "input-deck")
        try:
            solver_output = run_ccx_if_available(workdir, deck_path)
        except Exception as error:
            raise annotate_exception_phase(error, "solver-run")
        if solver_output["returnCode"] is None:
            raise UserFacingSolveError(CCX_UNAVAILABLE_ERROR, 503, {
                "artifacts": artifacts_for_failure(input_deck, solver_output, "ccx-unavailable", mesh, boundaries)
            })
        try:
            parsed_solver_results = parse_calculix_results(workdir, parsed, mesh, boundaries, input_deck, solver_output)
        except Exception as error:
            raise annotate_exception_phase(error, "result-parsing")

    if is_parsed_calculix_status(parsed_solver_results["artifacts"]["solverResultParser"]):
        return parsed_solver_results

    raise UserFacingSolveError(UNPARSED_RESULTS_ERROR, 422, {
        "artifacts": artifacts_for_failure(input_deck, solver_output, parsed_solver_results["artifacts"]["solverResultParser"], mesh, boundaries)
    })


def parse_payload(payload):
    run_id = payload.get("runId") if isinstance(payload.get("runId"), str) else "run-cloud-container"
    study = payload.get("study") if isinstance(payload.get("study"), dict) else {}
    analysis_type = resolved_analysis_type(payload, study)
    dynamic = analysis_type == "dynamic_structural"
    dynamic_settings = normalized_dynamic_settings(dynamic_settings_payload(payload, study)) if dynamic else None
    material = material_properties(payload)
    geometry = uploaded_geometry_payload(payload)
    dimensions = None if geometry else resolve_block_dimensions(payload)
    normalized_loads = normalize_loads(study, payload)
    if not normalized_loads:
        raise diagnostic_error("Cloud FEA requires at least one supported load.", "cloud-fea-load-missing")
    fixed_constraints = fixed_support_constraints(study)
    if not fixed_constraints:
        raise UserFacingSolveError("Cloud FEA requires a fixed support.", 422)
    force_load_vectors = [load["totalForceN"] for load in normalized_loads if load["kind"] == "surface_force"]
    legacy_load_vector = vector_sum(force_load_vectors) if force_load_vectors else [0.0, 0.0, 0.0]
    parsed = {
        "runId": run_id,
        "study": study,
        "displayModel": payload.get("displayModel") if isinstance(payload.get("displayModel"), dict) else {},
        "resultRenderBounds": payload.get("resultRenderBounds") if isinstance(payload.get("resultRenderBounds"), dict) else None,
        "analysisType": analysis_type,
        "dynamic": dynamic,
        "dynamicSettings": dynamic_settings,
        "material": material,
        "dimensions": dimensions,
        "meshDensity": mesh_density_for(payload.get("fidelity")),
        "fidelity": payload.get("fidelity") if isinstance(payload.get("fidelity"), str) else "standard",
        "loads": normalized_loads,
        "fixedConstraints": fixed_constraints,
        "load": first_record(study.get("loads")),
        "constraint": fixed_constraints[0],
        "loadVector": legacy_load_vector,
        "loadMagnitude": vector_length(legacy_load_vector),
        "geometry": geometry
    }
    return parsed


def resolved_analysis_type(payload, study):
    if payload.get("analysisType") == "dynamic_structural" or study.get("type") == "dynamic_structural":
        return "dynamic_structural"
    if isinstance(payload.get("dynamicSettings"), dict):
        return "dynamic_structural"
    return "static_stress"


def dynamic_settings_payload(payload, study):
    if isinstance(payload.get("dynamicSettings"), dict):
        return payload["dynamicSettings"]
    solver_settings = study.get("solverSettings") if isinstance(study.get("solverSettings"), dict) else {}
    return solver_settings


def normalized_dynamic_settings(raw):
    raw = raw if isinstance(raw, dict) else {}
    start_time = finite_number_or(raw.get("startTime"), 0.0)
    end_time = finite_number_or(raw.get("endTime"), 0.1)
    time_step = finite_number_or(raw.get("timeStep"), 0.005)
    output_interval = finite_number_or(raw.get("outputInterval"), max(time_step, 0.005))
    damping_ratio = finite_number_or(raw.get("dampingRatio"), 0.02)
    load_profile = str(raw.get("loadProfile") or "ramp")
    diagnostics = []
    if load_profile not in {"ramp", "step", "sinusoidal", "quasi_static"}:
        diagnostics.append(dynamic_diagnostic("cloud-fea-dynamic-load-profile", "Cloud FEA dynamic loadProfile must be ramp, step, sinusoidal, or quasi_static."))
    if not math.isfinite(start_time) or start_time < 0:
        diagnostics.append(dynamic_diagnostic("cloud-fea-dynamic-start-time", "Cloud FEA dynamic startTime must be a finite non-negative number."))
    if not math.isfinite(end_time) or end_time <= start_time:
        diagnostics.append(dynamic_diagnostic("cloud-fea-dynamic-end-time", "Cloud FEA dynamic endTime must be greater than startTime."))
    if not math.isfinite(time_step) or time_step <= 0:
        diagnostics.append(dynamic_diagnostic("cloud-fea-dynamic-time-step", "Cloud FEA dynamic timeStep must be a finite positive number."))
    if not math.isfinite(output_interval) or output_interval <= 0:
        diagnostics.append(dynamic_diagnostic("cloud-fea-dynamic-output-interval", "Cloud FEA dynamic outputInterval must be a finite positive number."))
    if math.isfinite(time_step) and math.isfinite(output_interval) and output_interval < time_step:
        diagnostics.append(dynamic_diagnostic("cloud-fea-dynamic-output-interval", "Cloud FEA dynamic outputInterval must be greater than or equal to timeStep."))
    if not math.isfinite(damping_ratio) or damping_ratio < 0:
        diagnostics.append(dynamic_diagnostic("cloud-fea-dynamic-damping-ratio", "Cloud FEA dynamic dampingRatio must be a finite non-negative number."))
    frame_count = dynamic_frame_count(start_time, end_time, output_interval) if not diagnostics else 0
    if frame_count > MAX_DYNAMIC_FRAMES:
        diagnostics.append(dynamic_diagnostic("cloud-fea-dynamic-frame-budget", "Dynamic Cloud FEA output would exceed frame budget; increase outputInterval or reduce endTime."))
    if diagnostics:
        raise UserFacingSolveError(diagnostics[0]["message"], 422, {"diagnostics": diagnostics})
    settings = {
        "startTime": float(start_time),
        "endTime": float(end_time),
        "timeStep": float(time_step),
        "outputInterval": float(output_interval),
        "dampingRatio": float(damping_ratio),
        "loadProfile": load_profile,
        "integrationMethod": "calculix_dynamic_direct",
        "frameCount": frame_count,
    }
    for key in ("rayleighAlpha", "rayleighBeta"):
        value = raw.get(key)
        if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
            settings[key] = float(value)
    return settings


def finite_number_or(value, fallback):
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else float(fallback)


def dynamic_frame_count(start_time, end_time, output_interval):
    duration = max(end_time - start_time, 0.0)
    return int(math.floor(duration / output_interval + 1e-9)) + 1


def dynamic_diagnostic(diagnostic_id, message):
    return {
        "id": diagnostic_id,
        "severity": "error",
        "source": "preflight",
        "message": message,
        "suggestedActions": [],
    }


def fixed_support_constraints(study):
    constraints = study.get("constraints") if isinstance(study.get("constraints"), list) else []
    return [
        constraint
        for constraint in constraints
        if isinstance(constraint, dict) and constraint.get("type") == "fixed" and isinstance(constraint.get("selectionRef"), str)
    ]


def normalize_loads(study, payload=None):
    loads = study.get("loads") if isinstance(study.get("loads"), list) else []
    normalized = []
    unsupported = []
    for load in loads:
        if not isinstance(load, dict):
            continue
        load_type = load.get("type")
        try:
            if load_type == "force":
                normalized.append(normalize_force_load(load))
            elif load_type == "gravity":
                normalized.append(normalize_gravity_load(load, payload or {}))
            elif load_type == "pressure":
                normalized.append(normalize_pressure_load(load))
            else:
                unsupported.append(str(load_type or "unknown"))
        except UserFacingSolveError:
            raise
        except Exception as error:
            raise diagnostic_error(str(error), "cloud-fea-load-normalization-failed") from error
    if unsupported:
        raise diagnostic_error(
            f"Cloud FEA does not support load type(s): {', '.join(unsupported)}.",
            "cloud-fea-load-unsupported",
            {"unsupportedLoadTypes": unsupported, "supportedLoadTypes": ["force", "pressure", "gravity"]},
        )
    return normalized


def normalize_force_load(load):
    params = load_parameters(load)
    value = load_value(params, "Cloud FEA force load requires a positive finite force value.")
    units = str(params.get("units") or "N")
    if units != "N":
        raise diagnostic_error(f"Cloud FEA force load units must be N; received {units}.", "cloud-fea-force-unit-unsupported")
    direction = unit_vector(params.get("direction"))
    return {
        "kind": "surface_force",
        "sourceLoadId": load_id(load),
        "selectionRef": load_selection_ref(load),
        "totalForceN": [value * component for component in direction],
        "units": "N",
    }


def normalize_gravity_load(load, payload):
    params = load_parameters(load)
    mass_kg = payload_mass_kg(params, payload)
    if mass_kg is None:
        raise diagnostic_error(
            "Payload mass load could not be converted to an equivalent force because mass is missing.",
            "cloud-fea-payload-mass-missing",
        )
    direction = unit_vector(params.get("direction") if is_vec3(params.get("direction")) else [0.0, 0.0, -1.0])
    return {
        "kind": "surface_force",
        "sourceLoadId": load_id(load),
        "selectionRef": load_selection_ref(load),
        "totalForceN": [mass_kg * STANDARD_GRAVITY * component for component in direction],
        "units": "N",
    }


def normalize_pressure_load(load):
    params = load_parameters(load)
    value = load_value(params, "Cloud FEA pressure load requires a positive finite pressure value.")
    units = str(params.get("units") or "kPa")
    pressure = pressure_to_n_per_mm2(value, units)
    normalized = {
        "kind": "surface_pressure",
        "sourceLoadId": load_id(load),
        "selectionRef": load_selection_ref(load),
        "pressureNPerMm2": pressure,
        "units": "N/mm^2",
    }
    if is_vec3(params.get("direction")):
        normalized["direction"] = unit_vector(params.get("direction"))
    return normalized


def load_parameters(load):
    params = load.get("parameters")
    return params if isinstance(params, dict) else {}


def load_id(load):
    return str(load.get("id") or f"load-{len(str(load))}")


def load_selection_ref(load):
    selection_ref = load.get("selectionRef")
    if not isinstance(selection_ref, str) or not selection_ref:
        raise diagnostic_error("Cloud FEA load selectionRef is missing.", "cloud-fea-load-selection-missing")
    return selection_ref


def load_value(params, message):
    value = params.get("value")
    if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise diagnostic_error(message, "cloud-fea-load-value-invalid")
    return float(value)


def payload_mass_kg(params, payload):
    candidates = [
        params.get("payloadMassKg"),
        params.get("value") if params.get("units") == "kg" else None,
    ]
    metadata = payload.get("payloadMetadata") if isinstance(payload, dict) and isinstance(payload.get("payloadMetadata"), dict) else {}
    candidates.append(metadata.get("payloadMassKg"))
    for candidate in candidates:
        if isinstance(candidate, (int, float)) and math.isfinite(candidate) and candidate > 0:
            return float(candidate)
    return None


def pressure_to_n_per_mm2(value, units):
    if units == "Pa":
        return value / 1_000_000.0
    if units == "kPa":
        return value / 1000.0
    if units in {"MPa", "N/mm^2", "N/mm2"}:
        return value
    raise diagnostic_error(f"Cloud FEA pressure load units are unsupported: {units}.", "cloud-fea-pressure-unit-unsupported")


def diagnostic_error(message, diagnostic_id, details=None):
    return UserFacingSolveError(message, 422, {
        "diagnostics": [{
            "id": diagnostic_id,
            "severity": "error",
            "source": "preflight",
            "message": message,
            "suggestedActions": [],
            **({"details": details} if details else {}),
        }]
    })


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
    fixed_mappings = []
    fixed_node_set = set()
    for constraint in parsed.get("fixedConstraints", [parsed.get("constraint")]):
        if not isinstance(constraint, dict):
            continue
        plane = plane_for_selection(parsed, constraint.get("selectionRef"))
        node_ids = node_ids_on_plane(mesh, plane)
        if node_ids:
            fixed_mappings.append({"constraint": constraint, "plane": plane, "nodeIds": node_ids})
            fixed_node_set.update(node_ids)
    load_boundaries = []
    load_node_set = set()
    for load in parsed.get("loads", []):
        plane = plane_for_selection(parsed, load.get("selectionRef"))
        node_ids = node_ids_on_plane(mesh, plane)
        if node_ids:
            area = structured_plane_area(mesh, plane)
            load_boundaries.append({"load": load, "plane": plane, "nodeIds": node_ids, "area": area, "normal": plane_normal(plane)})
            load_node_set.update(node_ids)
    fixed_node_ids = sorted(fixed_node_set)
    load_node_ids = sorted(load_node_set)
    if not fixed_node_ids or not load_node_ids:
        raise UserFacingSolveError("Structured block boundary selection did not resolve to non-empty node sets.", 422)
    return {
        "fixedPlane": fixed_mappings[0]["plane"] if fixed_mappings else None,
        "loadPlane": load_boundaries[0]["plane"] if load_boundaries else None,
        "fixedNodeIds": fixed_node_ids,
        "loadNodeIds": load_node_ids,
        "fixedBoundaries": fixed_mappings,
        "loadBoundaries": load_boundaries,
        "appliedLoadVector": vector_sum([load["totalForceN"] for load in parsed.get("loads", []) if load.get("kind") == "surface_force"]),
        "appliedLoadMagnitude": sum(vector_length(load["totalForceN"]) for load in parsed.get("loads", []) if load.get("kind") == "surface_force"),
        "diagnostics": [
            *[
                boundary_diagnostic("cloud-fea-fixed-plane", "Fixed support", item["plane"], len(item["nodeIds"]))
                for item in fixed_mappings
            ],
            *[
                boundary_diagnostic("cloud-fea-load-plane", "Applied load", item["plane"], len(item["nodeIds"]), load_total_force_preview(item["load"], item))
                for item in load_boundaries
            ],
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


def structured_plane_area(mesh, plane):
    dimensions = mesh.get("dimensions") if isinstance(mesh.get("dimensions"), dict) else {}
    axis = plane["axis"]
    other_axes = [item for item in AXES if item != axis]
    spans = [dimensions.get(item) for item in other_axes]
    if all(is_positive_finite(span) for span in spans):
        return float(spans[0]) * float(spans[1])
    return 0.0


def plane_normal(plane):
    normal = [0.0, 0.0, 0.0]
    axis_index = AXES.index(plane["axis"])
    normal[axis_index] = 1.0 if plane.get("side") == "max" else -1.0
    return normal


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


def distribute_normalized_loads_to_nodes(parsed, mesh, boundaries):
    nodal_loads = []
    applied_vectors = []
    applied_magnitude = 0.0
    for boundary in boundaries.get("loadBoundaries", []):
        load = boundary.get("load")
        if not isinstance(load, dict):
            continue
        if load.get("kind") == "surface_force":
            total_force = load.get("totalForceN")
        elif load.get("kind") == "surface_pressure":
            pressure = load.get("pressureNPerMm2")
            area = boundary.get("area")
            if not is_positive_finite(pressure) or not is_positive_finite(area):
                raise UserFacingSolveError("Cloud FEA pressure load could not be converted because selected face area is unavailable.", 422)
            direction = load.get("direction") if is_vec3(load.get("direction")) else boundary.get("normal")
            total_force = [float(pressure) * float(area) * component for component in unit_vector(direction)]
        else:
            continue
        if not is_vec3(total_force):
            raise UserFacingSolveError("Cloud FEA normalized load did not contain a finite force vector.", 422)
        applied_vectors.append(total_force)
        applied_magnitude += vector_length(total_force)
        if mesh.get("source") == "gmsh_uploaded_geometry":
            nodal_loads.extend(distribute_total_force_over_facets(mesh, boundary.get("facetIds", []), total_force))
        else:
            nodal_loads.extend(distribute_total_force_to_nodes(mesh, boundary.get("nodeIds", []), total_force))
    combined = combine_nodal_loads(nodal_loads)
    boundaries["appliedLoadVector"] = vector_sum(applied_vectors)
    boundaries["appliedLoadMagnitude"] = applied_magnitude
    return combined


def load_total_force_preview(load, boundary):
    if load.get("kind") == "surface_force":
        return load.get("totalForceN")
    if load.get("kind") == "surface_pressure" and is_positive_finite(load.get("pressureNPerMm2")) and is_positive_finite(boundary.get("area")):
        direction = load.get("direction") if is_vec3(load.get("direction")) else boundary.get("normal")
        if is_vec3(direction):
            return [load["pressureNPerMm2"] * boundary["area"] * component for component in unit_vector(direction)]
    return None


def combine_nodal_loads(nodal_loads):
    combined = {}
    for load in nodal_loads:
        node_id = load.get("nodeId")
        components = load.get("components")
        if not isinstance(node_id, int) or not is_vec3(components):
            continue
        current = combined.setdefault(node_id, [0.0, 0.0, 0.0])
        for axis in range(3):
            current[axis] += components[axis]
    return [
        {"nodeId": node_id, "components": components}
        for node_id, components in sorted(combined.items())
        if vector_length(components) > 1e-14
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
    fixed_mappings = []
    for constraint in parsed.get("fixedConstraints", [parsed.get("constraint")]):
        if not isinstance(constraint, dict):
            continue
        fixed_mappings.append(uploaded_face_mapping(parsed, mesh, constraint.get("selectionRef"), "Fixed support"))
    load_mappings = []
    for load in parsed.get("loads", []):
        mapping = uploaded_face_mapping(parsed, mesh, load.get("selectionRef"), "Applied load")
        load_mappings.append({
            "load": load,
            "mapping": mapping,
            "facetIds": [facet["id"] for facet in mapping["facets"]],
            "nodeIds": sorted({node_id for facet in mapping["facets"] for node_id in facet["nodeIds"]}),
            "area": sum(facet["area"] for facet in mapping["facets"]),
            "normal": mapping["plane"].get("normal"),
        })
    fixed_nodes = sorted({node_id for mapping in fixed_mappings for facet in mapping["facets"] for node_id in facet["nodeIds"]})
    load_nodes = sorted({node_id for mapping in load_mappings for node_id in mapping["nodeIds"]})
    if not fixed_nodes or not load_nodes or not set(fixed_nodes).isdisjoint(load_nodes):
        raise uploaded_face_mapping_error("Mapped uploaded-geometry support and load faces must be non-empty and disjoint.", parsed, mesh)
    return {
        "fixedNodeIds": fixed_nodes,
        "loadNodeIds": load_nodes,
        "fixedFacetIds": sorted({facet["id"] for mapping in fixed_mappings for facet in mapping["facets"]}),
        "loadFacetIds": sorted({facet_id for mapping in load_mappings for facet_id in mapping["facetIds"]}),
        "fixedPlane": fixed_mappings[0]["plane"] if fixed_mappings else None,
        "loadPlane": load_mappings[0]["mapping"]["plane"] if load_mappings else None,
        "fixedBoundaries": fixed_mappings,
        "loadBoundaries": [
            {
                "load": item["load"],
                "plane": item["mapping"]["plane"],
                "nodeIds": item["nodeIds"],
                "facetIds": item["facetIds"],
                "area": item["area"],
                "normal": item["normal"],
            }
            for item in load_mappings
        ],
        "appliedLoadVector": vector_sum([load["totalForceN"] for load in parsed.get("loads", []) if load.get("kind") == "surface_force"]),
        "appliedLoadMagnitude": sum(vector_length(load["totalForceN"]) for load in parsed.get("loads", []) if load.get("kind") == "surface_force"),
        "diagnostics": [
            *[
                uploaded_boundary_diagnostic(
                    "cloud-fea-uploaded-fixed-face",
                    "Fixed support",
                    mapping,
                    len({node_id for facet in mapping["facets"] for node_id in facet["nodeIds"]}),
                )
                for mapping in fixed_mappings
            ],
            *[
                uploaded_boundary_diagnostic("cloud-fea-uploaded-load-face", "Applied load", item["mapping"], len(item["nodeIds"]), load_total_force_preview(item["load"], item))
                for item in load_mappings
            ],
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
    header = [
        "*HEADING",
        f'OpenCAE {mesh.get("source", "structured_block")} CalculiX {"dynamic structural" if parsed.get("dynamic") else "static structural"} solve',
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
    ]
    if parsed.get("dynamic"):
        return "\n".join([*header, *write_dynamic_step(parsed, nodal_loads), ""])
    return "\n".join([*header, *write_static_step(nodal_loads), ""])


def write_static_step(nodal_loads):
    return [
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
    ]


def write_dynamic_step(parsed, nodal_loads):
    settings = parsed["dynamicSettings"]
    start_time = settings["startTime"]
    end_time = settings["endTime"]
    duration = end_time - start_time
    time_step = settings["timeStep"]
    output_interval = settings["outputInterval"]
    min_time_step = max(min(time_step / 100.0, duration * 1e-6), 1e-12)
    max_time_step = min(time_step, output_interval)
    lines = []
    damping_args = []
    if "rayleighAlpha" in settings:
        damping_args.append(f'ALPHA={settings["rayleighAlpha"]:.12g}')
    if "rayleighBeta" in settings:
        damping_args.append(f'BETA={settings["rayleighBeta"]:.12g}')
    if damping_args:
        lines.append(f"*DAMPING, {', '.join(damping_args)}")
    lines.extend([
        "*TIME POINTS, NAME=OUTPUT_TIMES, GENERATE",
        f"{start_time:.12g}, {end_time:.12g}, {output_interval:.12g}",
        "*AMPLITUDE, NAME=LOAD_HISTORY, TIME=TOTAL TIME",
        *format_amplitude_lines(amplitude_table_for_dynamic(settings)),
        "*STEP, NLGEOM=NO",
        "*DYNAMIC, ALPHA=-0.05",
        f"{time_step:.12g}, {duration:.12g}, {min_time_step:.12g}, {max_time_step:.12g}",
        "*BOUNDARY",
        "FIXED, 1, 3",
        "*CLOAD, AMPLITUDE=LOAD_HISTORY",
        *format_cload_lines(nodal_loads),
        "*NODE FILE, NSET=NALL, TIME POINTS=OUTPUT_TIMES",
        "U,V",
        "*EL FILE, ELSET=SOLID, TIME POINTS=OUTPUT_TIMES",
        "S",
        "*NODE PRINT, NSET=FIXED, TIME POINTS=OUTPUT_TIMES",
        "RF",
        "*EL PRINT, ELSET=SOLID, TIME POINTS=OUTPUT_TIMES",
        "S",
        "*END STEP",
    ])
    return lines


def amplitude_table_for_dynamic(settings):
    start_time = float(settings["startTime"])
    end_time = float(settings["endTime"])
    duration = end_time - start_time
    profile = settings.get("loadProfile") or "ramp"
    if profile == "step":
        return [(start_time, 1.0), (end_time, 1.0)]
    if profile in {"ramp", "quasi_static"}:
        return [(start_time, 0.0), (end_time, 1.0)]
    if profile == "sinusoidal":
        time_step = float(settings.get("timeStep") or duration / 20.0)
        segment_count = max(8, min(80, int(math.ceil(duration / max(time_step, 1e-12))) * 2))
        table = []
        for index in range(segment_count + 1):
            fraction = index / segment_count
            table.append((start_time + duration * fraction, math.sin(math.pi * fraction)))
        return table
    return [(start_time, 0.0), (end_time, 1.0)]


def format_amplitude_lines(table):
    lines = []
    pairs = [f"{time:.12g}, {value:.12g}" for time, value in table]
    for index in range(0, len(pairs), 4):
        lines.append(", ".join(pairs[index:index + 4]))
    return lines


def format_id_lines(ids):
    sorted_ids = sorted(ids)
    return [", ".join(str(item) for item in sorted_ids[index:index + 16]) for index in range(0, len(sorted_ids), 16)]


def format_cload_lines(nodal_loads):
    lines = []
    for load in combine_nodal_loads(nodal_loads):
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
    frd_files = [workdir / name for name in files if name.endswith(".frd")]
    parsed = context.get("parsed") if isinstance(context.get("parsed"), dict) else {}
    if parsed.get("dynamic"):
        dynamic_frames = []
        parser_diagnostics = []
        for dat_path in dat_files:
            dynamic_frames.extend(parse_dat_result_frames(dat_path.read_text(errors="ignore"), mesh))
        for frd_path in frd_files:
            merge_frd_frames(dynamic_frames, parse_frd_result_frames(frd_path.read_text(errors="ignore"), mesh))
        dynamic_frames = normalize_dynamic_frames(dynamic_frames)
        if dynamic_frames and any(frame.get("displacements") for frame in dynamic_frames) and any(frame.get("stresses") for frame in dynamic_frames):
            return {
                "frames": dynamic_frames,
                "available": True,
                "files": files,
                "status": "parsed-calculix-framed",
                "resultSource": "parsed_frd_dat" if frd_files and dat_files else "parsed_frd" if frd_files else "parsed_dat",
                "visualizationSource": "frd_nodal_stress" if any(frame.get("nodalStresses") for frame in dynamic_frames) else "dat_integration_points",
                "parserDiagnostics": parser_diagnostics,
            }
        return {
            "available": any(name.endswith((".frd", ".dat")) for name in files),
            "files": files,
            "frames": dynamic_frames,
            "displacements": {},
            "reactions": {},
            "stresses": [],
            "nodalStresses": [],
            "frdDisplacements": {},
            "parserDiagnostics": parser_diagnostics or ["dynamic-frames-unparsed"],
            "status": f"unparsed-calculix-output-for-{run_id}",
            "resultSource": "unknown",
            "visualizationSource": "unknown"
        }
    nodal_stresses = []
    frd_displacements = {}
    parser_diagnostics = []
    for frd_path in frd_files:
        text = frd_path.read_text(errors="ignore")
        nodal_stresses.extend(parse_frd_nodal_stresses(text, mesh))
        frd_displacements.update(parse_frd_nodal_displacements(text))
    if frd_files and not nodal_stresses:
        parser_diagnostics.append("frd-nodal-stress-unparsed")
    for dat_path in dat_files:
        parsed = parse_dat_result(dat_path.read_text(errors="ignore"), mesh)
        if parsed["displacements"] and parsed["stresses"]:
            has_frd_visualization = bool(nodal_stresses)
            return {
                **parsed,
                "nodalStresses": nodal_stresses,
                "frdDisplacements": frd_displacements,
                "parserDiagnostics": parser_diagnostics,
                "available": True,
                "files": files,
                "status": "parsed-calculix-dat",
                "resultSource": "parsed_frd_dat" if has_frd_visualization else "parsed_dat",
                "visualizationSource": "frd_nodal_stress" if has_frd_visualization else "dat_integration_points"
            }
    return {
        "available": any(name.endswith((".frd", ".dat")) for name in files),
        "files": files,
        "displacements": {},
        "reactions": {},
        "stresses": [],
        "nodalStresses": nodal_stresses,
        "frdDisplacements": frd_displacements,
        "parserDiagnostics": parser_diagnostics,
        "status": f"unparsed-calculix-output-for-{run_id}",
        "resultSource": "unknown",
        "visualizationSource": "unknown"
    }


def parse_dat_result(text, mesh=None):
    parsed = parse_dat_nodal_displacements_and_reactions(text)
    parsed["stresses"] = parse_dat_integration_point_stresses(text, mesh)
    return parsed


def parse_dat_result_frames(text, mesh=None):
    frames_by_time = {}
    section = None
    current = None
    for line in text.splitlines():
        lowered = line.lower()
        if "displacements" in lowered:
            current = dat_frame_for_line(frames_by_time, line)
            section = "u"
            continue
        if "velocities" in lowered:
            current = dat_frame_for_line(frames_by_time, line)
            section = "v"
            continue
        if "stresses" in lowered:
            current = dat_frame_for_line(frames_by_time, line)
            section = "s"
            continue
        if "forces" in lowered or "reaction" in lowered:
            current = dat_frame_for_line(frames_by_time, line)
            section = "rf"
            continue
        values = floats_from_line(line)
        if current is None:
            continue
        if section in {"u", "v", "rf"} and len(values) >= 4 and integer_like(values[0]):
            target = current["displacements"] if section == "u" else current["velocities"] if section == "v" else current["reactions"]
            target[int(round(values[0]))] = values[-3:]
        elif section == "s" and len(values) >= 7 and integer_like(values[0]):
            element_id = int(round(values[0]))
            components = values[-6:]
            current["stresses"].append({
                "elementId": element_id,
                "components": components,
                "vonMises": von_mises(components),
                "point": element_centroid(mesh, element_id) if mesh is not None else None
            })
    return list(frames_by_time.values())


def dat_frame_for_line(frames_by_time, line):
    time_seconds = time_from_result_header(line)
    key = round(time_seconds, 12)
    frame = frames_by_time.get(key)
    if frame is None:
        frame = {
            "timeSeconds": time_seconds,
            "displacements": {},
            "velocities": {},
            "reactions": {},
            "stresses": [],
            "nodalStresses": [],
        }
        frames_by_time[key] = frame
    return frame


def time_from_result_header(line):
    match = re.search(r"\btime\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?)", line, re.IGNORECASE)
    if match:
        try:
            return float(match.group(1).replace("D", "E").replace("d", "E"))
        except ValueError:
            return 0.0
    values = floats_from_line(line)
    return values[-1] if values else 0.0


def parse_frd_result_frames(text, mesh=None):
    records = parse_frd_nodal_result_records(text)
    displacements = {node_id: values[:3] for node_id, values in records["displacements"].items() if len(values) >= 3}
    velocities = {node_id: values[:3] for node_id, values in records.get("velocities", {}).items() if len(values) >= 3}
    stresses = parse_frd_nodal_stresses(text, mesh)
    if not displacements and not velocities and not stresses:
        return []
    return [{
        "timeSeconds": 0.0,
        "displacements": displacements,
        "velocities": velocities,
        "reactions": {},
        "stresses": [],
        "nodalStresses": stresses,
    }]


def merge_frd_frames(target_frames, frd_frames):
    if not frd_frames:
        return target_frames
    if not target_frames:
        target_frames.extend(frd_frames)
        return target_frames
    for index, frd_frame in enumerate(frd_frames):
        target = target_frames[min(index, len(target_frames) - 1)]
        if frd_frame.get("displacements"):
            target["displacements"] = frd_frame["displacements"]
        if frd_frame.get("velocities"):
            target["velocities"] = frd_frame["velocities"]
        if frd_frame.get("nodalStresses"):
            target["nodalStresses"] = frd_frame["nodalStresses"]
    return target_frames


def normalize_dynamic_frames(frames):
    normalized = []
    for index, frame in enumerate(sorted(frames, key=lambda item: item.get("timeSeconds", 0.0))):
        item = dict(frame)
        item.setdefault("displacements", {})
        item.setdefault("velocities", {})
        item.setdefault("reactions", {})
        item.setdefault("stresses", [])
        item.setdefault("nodalStresses", [])
        item["frameIndex"] = index
        item["timeSeconds"] = float(item.get("timeSeconds", 0.0))
        normalized.append(item)
    return normalized


def parse_dat_nodal_displacements_and_reactions(text):
    displacements = {}
    reactions = {}
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
    return {"displacements": displacements, "reactions": reactions}


def parse_dat_integration_point_stresses(text, mesh=None):
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
        if section == "s" and len(values) >= 7 and integer_like(values[0]):
            element_id = int(round(values[0]))
            components = values[-6:]
            stresses.append({
                "elementId": element_id,
                "components": components,
                "vonMises": von_mises(components),
                "point": element_centroid(mesh, element_id) if mesh is not None else None
            })
    return stresses


def parse_frd_nodal_stresses(text, mesh=None):
    records = parse_frd_nodal_result_records(text)
    coordinates = records["coordinates"]
    mesh_nodes = node_coordinates_by_id(mesh)
    stresses = []
    for node_id, components in records["stresses"].items():
        if len(components) < 6:
            continue
        point = coordinates.get(node_id) or mesh_nodes.get(node_id)
        if point is None:
            continue
        stress_components = components[:6]
        stresses.append({
            "nodeId": node_id,
            "components": stress_components,
            "vonMises": von_mises(stress_components),
            "point": point
        })
    return sorted(stresses, key=lambda stress: stress["nodeId"])


def parse_frd_nodal_displacements(text):
    records = parse_frd_nodal_result_records(text)
    return {node_id: values[:3] for node_id, values in records["displacements"].items() if len(values) >= 3}


def parse_frd_nodal_result_records(text):
    coordinates = {}
    displacements = {}
    velocities = {}
    stresses = {}
    section = None
    for line in text.splitlines():
        stripped = line.strip()
        upper = stripped.upper()
        if not stripped:
            continue
        if upper.startswith("2C"):
            section = "coordinates"
            continue
        if upper.startswith("-3"):
            section = None
            continue
        if upper.startswith("-4"):
            if "STRESS" in upper and "STRESSI" not in upper:
                section = "stress"
            elif "DISP" in upper:
                section = "displacement"
            elif upper.startswith("-4") and re.search(r"\bV(?:ELOCITY|ELOC)?\b", upper):
                section = "velocity"
            else:
                section = "other"
            continue
        if upper.startswith("-5"):
            continue
        if not upper.startswith("-1"):
            continue
        values = floats_from_line(line)
        if len(values) < 2 or not integer_like(values[1]):
            continue
        node_id = int(round(values[1]))
        payload = values[2:]
        if section == "coordinates" and len(payload) >= 3:
            coordinates[node_id] = payload[:3]
        elif section == "displacement" and len(payload) >= 3:
            displacements[node_id] = payload[:3]
        elif section == "velocity" and len(payload) >= 3:
            velocities[node_id] = payload[:3]
        elif section == "stress" and len(payload) >= 6:
            stresses[node_id] = payload[:6]
    return {"coordinates": coordinates, "displacements": displacements, "velocities": velocities, "stresses": stresses}


def node_coordinates_by_id(mesh):
    if not isinstance(mesh, dict) or not isinstance(mesh.get("nodes"), list):
        return {}
    return {
        node["id"]: node["coordinates"]
        for node in mesh["nodes"]
        if isinstance(node, dict) and isinstance(node.get("id"), int) and is_vec3(node.get("coordinates"))
    }


def solver_bounds_for_structured_block(dimensions):
    return {
        "min": [0.0, 0.0, 0.0],
        "max": [float(dimensions[axis]) for axis in AXES],
    }


def display_bounds_for_payload(parsed):
    render_bounds = parsed.get("resultRenderBounds") if isinstance(parsed, dict) else None
    normalized = normalize_display_bounds(render_bounds)
    if normalized is not None:
        return normalized
    return display_bounds_for_model(parsed.get("displayModel", {}), parsed.get("dimensions")) if isinstance(parsed, dict) else None


def normalize_display_bounds(bounds):
    if not isinstance(bounds, dict):
        return None
    if bounds.get("coordinateSpace") != "display_model":
        return None
    minimum = bounds.get("min")
    maximum = bounds.get("max")
    if not is_vec3(minimum) or not is_vec3(maximum):
        return None
    spans = [maximum[index] - minimum[index] for index in range(3)]
    if not all(is_positive_finite(span) for span in spans):
        return None
    return {"min": [float(value) for value in minimum], "max": [float(value) for value in maximum], "coordinateSpace": "display_model"}


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
    return {"min": mins, "max": maxs, "coordinateSpace": "display_model"}


def solver_point_to_display(point_mm, solver_bounds, display_bounds):
    if display_bounds is None:
        return list(point_mm)
    mapped = []
    for axis_index in range(3):
        solver_min = solver_bounds["min"][axis_index]
        solver_max = solver_bounds["max"][axis_index]
        solver_span = solver_max - solver_min
        t = (point_mm[axis_index] - solver_min) / solver_span if solver_span > 0 else 0.0
        lo = display_bounds["min"][axis_index]
        hi = display_bounds["max"][axis_index]
        mapped.append(lo + t * (hi - lo))
    return mapped


def solver_vector_to_display(vector_mm, solver_bounds, display_bounds):
    if display_bounds is None:
        return list(vector_mm)
    mapped = []
    for axis_index in range(3):
        solver_span = solver_bounds["max"][axis_index] - solver_bounds["min"][axis_index]
        display_span = display_bounds["max"][axis_index] - display_bounds["min"][axis_index]
        scale = display_span / solver_span if solver_span > 0 else 1.0
        mapped.append(vector_mm[axis_index] * scale)
    return mapped


def surface_node_ids(mesh):
    if mesh.get("source") == "structured_block" and isinstance(mesh.get("density"), dict):
        density = mesh["density"]
        surface_ids = set()
        for node in mesh["nodes"]:
            ijk = node.get("ijk")
            if not isinstance(ijk, tuple) or len(ijk) != 3:
                continue
            if (
                ijk[0] in {0, density["nx"]}
                or ijk[1] in {0, density["ny"]}
                or ijk[2] in {0, density["nz"]}
            ):
                surface_ids.add(node["id"])
        return surface_ids
    return {node["id"] for node in mesh.get("nodes", []) if isinstance(node, dict) and isinstance(node.get("id"), int)}


def surface_nodal_stresses_from_dat(mesh, stresses):
    stress_by_element_id = {
        stress["elementId"]: stress["vonMises"]
        for stress in stresses
        if isinstance(stress, dict)
        and isinstance(stress.get("elementId"), int)
        and isinstance(stress.get("vonMises"), (int, float))
        and math.isfinite(stress["vonMises"])
    }
    if not stress_by_element_id:
        return []
    values_by_node_id = {}
    for element in mesh.get("elements", []):
        value = stress_by_element_id.get(element.get("id"))
        if value is None:
            continue
        for node_id in element.get("nodeIds", []):
            values_by_node_id.setdefault(node_id, []).append(value)
    surface_ids = surface_node_ids(mesh)
    nodes_by_id = node_coordinates_by_id(mesh)
    samples = []
    for node_id in sorted(surface_ids):
        values = values_by_node_id.get(node_id)
        point = nodes_by_id.get(node_id)
        if not values or point is None:
            continue
        samples.append({
            "nodeId": node_id,
            "point": point,
            "vonMises": sum(values) / len(values),
        })
    return samples


def response_from_parsed_dat(parsed, mesh, boundaries, input_deck, solver_output, parsed_dat):
    if parsed.get("dynamic") or parsed_dat.get("frames"):
        return response_from_parsed_dynamic(parsed, mesh, boundaries, input_deck, solver_output, parsed_dat)
    run_id = parsed["runId"]
    material = parsed["material"]
    structured_block = mesh.get("source", "structured_block") == "structured_block"
    solver_bounds = solver_bounds_for_structured_block(parsed["dimensions"]) if structured_block else None
    display_bounds = display_bounds_for_payload(parsed) if structured_block else None
    sample_coordinate_space = "display_model" if display_bounds is not None else "mm"
    diagnostics = list(boundaries["diagnostics"])
    if structured_block and display_bounds is None:
        diagnostics.append({
            "id": "cloud-fea-result-coordinate-transform-unavailable",
            "severity": "warning",
            "source": "solver",
            "message": "Cloud FEA result samples could not be transformed to display-model coordinates.",
            "suggestedActions": []
        })
    if mesh.get("elementType", "C3D8") == "C3D8" and parsed.get("fidelity") in {"detailed", "ultra"}:
        diagnostics.append({
            "id": "cloud-fea-quadratic-elements-recommended",
            "severity": "info",
            "source": "solver",
            "message": "C3D20R recommended for higher-quality bending stress visualization.",
            "suggestedActions": []
        })
    displacement_vectors = parsed_dat.get("frdDisplacements") or parsed_dat["displacements"]
    displacement_source = "calculix-frd" if parsed_dat.get("frdDisplacements") else "calculix-dat"
    displacement_samples = []
    for node in mesh["nodes"]:
        vector = displacement_vectors.get(node["id"])
        if vector is None:
            continue
        displacement_samples.append({
            "point": solver_point_to_display(node["coordinates"], solver_bounds, display_bounds),
            "normal": [0.0, 0.0, 1.0],
            "value": vector_length(vector),
            "vector": solver_vector_to_display(vector, solver_bounds, display_bounds),
            "nodeId": f'N{node["id"]}',
            "source": displacement_source
        })
    nodal_visualization_stresses = parsed_dat.get("nodalStresses") if isinstance(parsed_dat.get("nodalStresses"), list) else []
    if structured_block and nodal_visualization_stresses:
        surface_ids = surface_node_ids(mesh)
        nodal_visualization_stresses = [stress for stress in nodal_visualization_stresses if stress.get("nodeId") in surface_ids]
    if not nodal_visualization_stresses and structured_block:
        nodal_visualization_stresses = surface_nodal_stresses_from_dat(mesh, parsed_dat["stresses"])
    stress_samples = []
    if nodal_visualization_stresses:
        for stress in nodal_visualization_stresses:
            stress_samples.append({
                "point": solver_point_to_display(stress["point"], solver_bounds, display_bounds),
                "normal": [0.0, 0.0, 1.0],
                "value": stress["vonMises"],
                "nodeId": f'N{stress["nodeId"]}',
                "source": "calculix-nodal-surface",
                "vonMisesStressPa": stress["vonMises"] * 1_000_000.0
            })
    else:
        for stress in parsed_dat["stresses"]:
            if not is_vec3(stress.get("point")):
                continue
            stress_samples.append({
                "point": solver_point_to_display(stress["point"], solver_bounds, display_bounds),
                "normal": [0.0, 0.0, 1.0],
                "value": stress["vonMises"],
                "elementId": f'E{stress["elementId"]}',
                "source": "calculix-dat",
                "vonMisesStressPa": stress["vonMises"] * 1_000_000.0
            })
    stress_values = [sample["value"] for sample in stress_samples]
    displacement_values = [sample["value"] for sample in displacement_samples]
    engineering_stress_values = [stress["vonMises"] for stress in parsed_dat["stresses"] if isinstance(stress.get("vonMises"), (int, float)) and math.isfinite(stress["vonMises"])]
    max_stress = max(engineering_stress_values)
    max_displacement = max(displacement_values)
    reaction_force = reaction_force_magnitude(parsed_dat["reactions"], boundaries["fixedNodeIds"])
    if reaction_force <= 0:
        reaction_force = vector_length(boundaries.get("appliedLoadVector") or parsed.get("loadVector") or [0.0, 0.0, 0.0])
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
    stress_location = "node" if stress_samples and stress_samples[0].get("nodeId") else "element"
    fields = [
        field_from_samples(run_id, "stress", stress_location, "MPa", stress_values, stress_samples, provenance),
        field_from_samples(run_id, "displacement", "node", "mm", displacement_values, displacement_samples, provenance),
        field_from_samples(
            run_id,
            "safety_factor",
            stress_location,
            "",
            [material["yieldMpa"] / max(value, 0.001) for value in stress_values],
            [
                {
                    "point": sample["point"],
                    "normal": sample["normal"],
                    "value": material["yieldMpa"] / max(sample["value"], 0.001),
                    **({"nodeId": sample["nodeId"]} if sample.get("nodeId") else {}),
                    **({"elementId": sample["elementId"]} if sample.get("elementId") else {}),
                    "source": sample["source"]
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
            "message": "Cloud FEA results were parsed from CalculiX output."
        },
        "provenance": provenance
    }
    coordinate_mapping = {
        "solverCoordinateSpace": "mm",
        "resultSampleCoordinateSpace": sample_coordinate_space,
        "solverBoundsMm": solver_bounds,
        "displayBounds": display_bounds
    }
    result = {
        "summary": summary,
        "fields": fields,
        "diagnostics": diagnostics,
        "artifacts": {
            **compact_text_artifact(input_deck, MAX_INPUT_DECK_ARTIFACT_BYTES, "inputDeckPreview"),
            **compact_text_artifact(solver_output["log"], MAX_SOLVER_LOG_ARTIFACT_BYTES, "solverLogPreview", keep_tail=True),
            "solverResultFiles": parsed_dat["files"],
            "solverResultParser": parsed_dat["status"],
            "solverResultParserDiagnostics": parsed_dat.get("parserDiagnostics", []),
            "resultCoordinateMapping": coordinate_mapping,
            "runnerVersion": RUNNER_VERSION,
            "meshSummary": mesh_summary(mesh, boundaries, sample_coordinate_space),
            "solverMaterial": material
        }
    }
    try:
        return compact_cloud_fea_result(result)
    except Exception as error:
        raise annotate_exception_phase(error, "result-compaction")


def response_from_parsed_dynamic(parsed, mesh, boundaries, input_deck, solver_output, parsed_dat):
    run_id = parsed["runId"]
    material = parsed["material"]
    settings = parsed["dynamicSettings"]
    structured_block = mesh.get("source", "structured_block") == "structured_block"
    solver_bounds = solver_bounds_for_structured_block(parsed["dimensions"]) if structured_block else None
    display_bounds = display_bounds_for_payload(parsed) if structured_block else None
    sample_coordinate_space = "display_model" if display_bounds is not None else "mm"
    diagnostics = list(boundaries["diagnostics"])
    if structured_block and display_bounds is None:
        diagnostics.append({
            "id": "cloud-fea-result-coordinate-transform-unavailable",
            "severity": "warning",
            "source": "solver",
            "message": "Cloud FEA result samples could not be transformed to display-model coordinates.",
            "suggestedActions": []
        })
    if settings.get("dampingRatio", 0) > 0 and "rayleighAlpha" not in settings and "rayleighBeta" not in settings:
        diagnostics.append({
            "id": "cloud-fea-dynamic-damping-ratio-metadata-only",
            "severity": "warning",
            "source": "solver",
            "message": "Cloud FEA dynamic dampingRatio is not yet mapped to Rayleigh damping; use rayleighAlpha/rayleighBeta for physical damping.",
            "suggestedActions": []
        })
    frames = normalize_dynamic_frames(parsed_dat.get("frames", []))
    if len(frames) <= 1:
        raise UserFacingSolveError("Cloud FEA dynamic result did not include animation frames.", 422)
    provenance = {
        "kind": "calculix_fea",
        "solver": "calculix-ccx",
        "solverVersion": command_version(["ccx", "-v"]),
        "meshSource": mesh.get("source", "structured_block"),
        "resultSource": parsed_dat["resultSource"],
        "units": "mm-N-s-MPa",
        "integrationMethod": "calculix_dynamic_direct",
        "loadProfile": settings.get("loadProfile", "ramp"),
    }
    if settings.get("loadProfile") == "quasi_static":
        provenance["dynamicProfile"] = "quasi_static_dynamic"
    if display_bounds is not None:
        provenance["renderCoordinateSpace"] = "display_model"
    fields = []
    max_stress = 0.0
    max_displacement = 0.0
    peak_displacement_time = settings["startTime"]
    min_safety_factor = math.inf
    peak_reaction_force = 0.0
    previous_velocity_vectors = None
    previous_time = None
    for frame in frames:
        frame_index = frame["frameIndex"]
        time_seconds = frame["timeSeconds"]
        displacement_vectors = frame.get("displacements", {})
        velocity_vectors = frame.get("velocities") or derived_velocity_vectors(frame, frames, frame_index)
        acceleration_vectors = derived_acceleration_vectors(velocity_vectors, previous_velocity_vectors, time_seconds, previous_time)
        previous_velocity_vectors = velocity_vectors
        previous_time = time_seconds
        displacement_samples = vector_samples_for_nodes(mesh, displacement_vectors, solver_bounds, display_bounds, "calculix-frd" if parsed_dat.get("visualizationSource") == "frd_nodal_stress" else "calculix-dat")
        velocity_samples = vector_samples_for_nodes(mesh, velocity_vectors, solver_bounds, display_bounds, "calculix-frd")
        acceleration_samples = vector_samples_for_nodes(mesh, acceleration_vectors, solver_bounds, display_bounds, "derived-from-velocity")
        nodal_visualization_stresses = frame.get("nodalStresses") if isinstance(frame.get("nodalStresses"), list) else []
        if structured_block and nodal_visualization_stresses:
            surface_ids = surface_node_ids(mesh)
            nodal_visualization_stresses = [stress for stress in nodal_visualization_stresses if stress.get("nodeId") in surface_ids]
        if not nodal_visualization_stresses and structured_block:
            nodal_visualization_stresses = surface_nodal_stresses_from_dat(mesh, frame.get("stresses", []))
        stress_samples = stress_samples_for_frame(nodal_visualization_stresses, frame.get("stresses", []), solver_bounds, display_bounds)
        stress_values = [sample["value"] for sample in stress_samples]
        displacement_values = [sample["value"] for sample in displacement_samples]
        velocity_values = [sample["value"] for sample in velocity_samples]
        acceleration_values = [sample["value"] for sample in acceleration_samples]
        engineering_stress_values = [
            stress["vonMises"]
            for stress in frame.get("stresses", [])
            if isinstance(stress.get("vonMises"), (int, float)) and math.isfinite(stress["vonMises"])
        ]
        frame_max_stress = max(engineering_stress_values or stress_values or [0.0])
        frame_max_displacement = max(displacement_values or [0.0])
        frame_safety_factor = material["yieldMpa"] / max(frame_max_stress, 0.001)
        frame_reaction = reaction_force_magnitude(frame.get("reactions", {}), boundaries["fixedNodeIds"])
        max_stress = max(max_stress, frame_max_stress)
        if frame_max_displacement >= max_displacement:
            max_displacement = frame_max_displacement
            peak_displacement_time = time_seconds
        min_safety_factor = min(min_safety_factor, frame_safety_factor)
        peak_reaction_force = max(peak_reaction_force, frame_reaction)
        stress_location = "node" if stress_samples and stress_samples[0].get("nodeId") else "element"
        safety_values = [material["yieldMpa"] / max(value, 0.001) for value in stress_values]
        safety_samples = [
            {
                "point": sample["point"],
                "normal": sample["normal"],
                "value": material["yieldMpa"] / max(sample["value"], 0.001),
                **({"nodeId": sample["nodeId"]} if sample.get("nodeId") else {}),
                **({"elementId": sample["elementId"]} if sample.get("elementId") else {}),
                "source": sample["source"]
            }
            for sample in stress_samples
        ]
        fields.extend([
            field_from_samples(run_id, "stress", stress_location, "MPa", stress_values, stress_samples, provenance, frame_index, time_seconds),
            field_from_samples(run_id, "displacement", "node", "mm", displacement_values, displacement_samples, provenance, frame_index, time_seconds),
            field_from_samples(run_id, "velocity", "node", "mm/s", velocity_values, velocity_samples, provenance, frame_index, time_seconds),
            field_from_samples(run_id, "acceleration", "node", "mm/s^2", acceleration_values, acceleration_samples, {**provenance, "accelerationSource": "derived_from_velocity"}, frame_index, time_seconds),
            field_from_samples(run_id, "safety_factor", stress_location, "", safety_values, safety_samples, provenance, frame_index, time_seconds),
        ])
    if peak_reaction_force <= 0:
        peak_reaction_force = vector_length(boundaries.get("appliedLoadVector") or parsed.get("loadVector") or [0.0, 0.0, 0.0])
    safety_factor = min_safety_factor if math.isfinite(min_safety_factor) else material["yieldMpa"] / max(max_stress, 0.001)
    summary = {
        "maxStress": max_stress,
        "maxStressUnits": "MPa",
        "maxDisplacement": max_displacement,
        "maxDisplacementUnits": "mm",
        "safetyFactor": safety_factor,
        "reactionForce": peak_reaction_force,
        "reactionForceUnits": "N",
        "failureAssessment": {
            "status": "fail" if safety_factor < 1 else "pass",
            "title": "CalculiX transient FEA",
            "message": "Cloud FEA transient results were parsed from CalculiX output."
        },
        "provenance": provenance,
        "transient": {
            "analysisType": "dynamic_structural",
            "integrationMethod": "calculix_dynamic_direct",
            "startTime": settings["startTime"],
            "endTime": settings["endTime"],
            "timeStep": settings["timeStep"],
            "outputInterval": settings["outputInterval"],
            "dampingRatio": settings["dampingRatio"],
            "frameCount": len(frames),
            "peakDisplacementTimeSeconds": peak_displacement_time,
            "peakDisplacement": max_displacement,
        }
    }
    coordinate_mapping = {
        "solverCoordinateSpace": "mm",
        "resultSampleCoordinateSpace": sample_coordinate_space,
        "solverBoundsMm": solver_bounds,
        "displayBounds": display_bounds
    }
    result = {
        "summary": summary,
        "fields": fields,
        "diagnostics": diagnostics,
        "artifacts": {
            **compact_text_artifact(input_deck, MAX_INPUT_DECK_ARTIFACT_BYTES, "inputDeckPreview"),
            **compact_text_artifact(solver_output["log"], MAX_SOLVER_LOG_ARTIFACT_BYTES, "solverLogPreview", keep_tail=True),
            "solverResultFiles": parsed_dat["files"],
            "solverResultParser": parsed_dat["status"],
            "solverResultParserDiagnostics": parsed_dat.get("parserDiagnostics", []),
            "resultCoordinateMapping": coordinate_mapping,
            "runnerVersion": RUNNER_VERSION,
            "meshSummary": mesh_summary(mesh, boundaries, sample_coordinate_space),
            "solverMaterial": material,
            "dynamicSettings": settings,
        }
    }
    try:
        return compact_cloud_fea_result(result)
    except Exception as error:
        raise annotate_exception_phase(error, "result-compaction")


def vector_samples_for_nodes(mesh, vectors, solver_bounds, display_bounds, source):
    samples = []
    for node in mesh["nodes"]:
        vector = vectors.get(node["id"]) if isinstance(vectors, dict) else None
        if vector is None:
            continue
        samples.append({
            "point": solver_point_to_display(node["coordinates"], solver_bounds, display_bounds),
            "normal": [0.0, 0.0, 1.0],
            "value": vector_length(vector),
            "vector": solver_vector_to_display(vector, solver_bounds, display_bounds),
            "nodeId": f'N{node["id"]}',
            "source": source
        })
    return samples


def stress_samples_for_frame(nodal_stresses, stresses, solver_bounds, display_bounds):
    samples = []
    if nodal_stresses:
        for stress in nodal_stresses:
            samples.append({
                "point": solver_point_to_display(stress["point"], solver_bounds, display_bounds),
                "normal": [0.0, 0.0, 1.0],
                "value": stress["vonMises"],
                "nodeId": f'N{stress["nodeId"]}',
                "source": "calculix-nodal-surface",
                "vonMisesStressPa": stress["vonMises"] * 1_000_000.0
            })
        return samples
    for stress in stresses:
        if not is_vec3(stress.get("point")):
            continue
        samples.append({
            "point": solver_point_to_display(stress["point"], solver_bounds, display_bounds),
            "normal": [0.0, 0.0, 1.0],
            "value": stress["vonMises"],
            "elementId": f'E{stress["elementId"]}',
            "source": "calculix-dat",
            "vonMisesStressPa": stress["vonMises"] * 1_000_000.0
        })
    return samples


def derived_velocity_vectors(frame, frames, frame_index):
    if frame.get("velocities"):
        return frame["velocities"]
    if frame_index <= 0:
        return {node_id: [0.0, 0.0, 0.0] for node_id in frame.get("displacements", {})}
    previous = frames[frame_index - 1]
    dt = frame.get("timeSeconds", 0.0) - previous.get("timeSeconds", 0.0)
    if dt <= 0:
        return {node_id: [0.0, 0.0, 0.0] for node_id in frame.get("displacements", {})}
    velocities = {}
    for node_id, vector in frame.get("displacements", {}).items():
        previous_vector = previous.get("displacements", {}).get(node_id, [0.0, 0.0, 0.0])
        velocities[node_id] = [(vector[axis] - previous_vector[axis]) / dt for axis in range(3)]
    return velocities


def derived_acceleration_vectors(velocity_vectors, previous_velocity_vectors, time_seconds, previous_time):
    if not velocity_vectors:
        return {}
    if previous_velocity_vectors is None or previous_time is None:
        return {node_id: [0.0, 0.0, 0.0] for node_id in velocity_vectors}
    dt = time_seconds - previous_time
    if dt <= 0:
        return {node_id: [0.0, 0.0, 0.0] for node_id in velocity_vectors}
    accelerations = {}
    for node_id, vector in velocity_vectors.items():
        previous_vector = previous_velocity_vectors.get(node_id, [0.0, 0.0, 0.0])
        accelerations[node_id] = [(vector[axis] - previous_vector[axis]) / dt for axis in range(3)]
    return accelerations


def field_from_samples(run_id, field_type, location, units, values, samples, provenance, frame_index=None, time_seconds=None):
    frame_suffix = f"-{frame_index}" if frame_index is not None else "-0"
    field = {
        "id": f"field-{run_id}-{field_type}{frame_suffix}",
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
    if frame_index is not None:
        field["frameIndex"] = int(frame_index)
    if time_seconds is not None:
        field["timeSeconds"] = float(time_seconds)
    return field


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
        is_dynamic_frame = isinstance(field.get("frameIndex"), int)
        max_samples = MAX_DYNAMIC_FIELD_SAMPLES_PER_FRAME if is_dynamic_frame else MAX_FIELD_SAMPLES_PER_TYPE.get(field_type, MAX_RESULT_SAMPLES)
        max_values = MAX_DYNAMIC_FIELD_VALUES_PER_FRAME if is_dynamic_frame else MAX_RESULT_VALUES
        values = field.get("values") if isinstance(field.get("values"), list) else []
        samples = field.get("samples") if isinstance(field.get("samples"), list) else []
        compacted = compact_result_field(field, max_values, max_samples)
        fields.append(compacted)
        returned_samples = compacted.get("samples") if isinstance(compacted.get("samples"), list) else []
        returned_values = compacted.get("values") if isinstance(compacted.get("values"), list) else []
        compaction_fields.append({
            "type": field_type,
            "originalValueCount": len(values),
            "returnedValueCount": len(returned_values),
            "originalSampleCount": len(samples),
            "returnedSampleCount": len(returned_samples),
            "maxValues": max_values,
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
        "maxDynamicFrames": MAX_DYNAMIC_FRAMES,
        "maxDynamicFieldValuesPerFrame": MAX_DYNAMIC_FIELD_VALUES_PER_FRAME,
        "maxDynamicFieldSamplesPerFrame": MAX_DYNAMIC_FIELD_SAMPLES_PER_FRAME,
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
        "runnerVersion": RUNNER_VERSION,
        "meshSummary": mesh_summary(mesh, boundaries)
    }


def uploaded_geometry_failure_artifacts(parsed, parser_status, input_deck, solver_output):
    geometry = parsed.get("geometry") or {}
    return {
        **compact_text_artifact(input_deck, MAX_INPUT_DECK_ARTIFACT_BYTES, "inputDeckPreview"),
        **compact_text_artifact(solver_output["log"], MAX_SOLVER_LOG_ARTIFACT_BYTES, "solverLogPreview", keep_tail=True),
        "solverResultFiles": [],
        "solverResultParser": parser_status,
        "runnerVersion": RUNNER_VERSION,
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


def vector_sum(vectors):
    total = [0.0, 0.0, 0.0]
    for vector in vectors:
        if not is_vec3(vector):
            continue
        for axis in range(3):
            total[axis] += vector[axis]
    return total


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
    return isinstance(value, (list, tuple)) and len(value) == 3 and all(isinstance(component, (int, float)) and math.isfinite(component) for component in value)


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
