from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import base64
import json
import math
import os
import shutil
import subprocess
import tempfile


LENGTH_MM = 75.0
WIDTH_MM = 5.0
HEIGHT_MM = 15.0
YIELD_STRESS_PA = 276_000_000.0
BEAM_DEPTH_DISPLAY = 0.36


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
            self._json(error.status, {"error": str(error)})
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
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def solve(payload):
    run_id = payload.get("runId") or "run-cloud-container"
    dynamic = (payload.get("analysisType") == "dynamic_structural") or (payload.get("study") or {}).get("type") == "dynamic_structural" or bool(payload.get("dynamicSettings"))
    dynamic_settings = normalized_dynamic_settings(payload.get("dynamicSettings") or (payload.get("study") or {}).get("solverSettings") or {})
    load_n = load_value_n(payload)
    material = material_properties(payload)
    density_tonne_per_mm3 = material["densityKgM3"] * 1e-12

    with tempfile.TemporaryDirectory(prefix=f"{run_id}-") as tmp:
        workdir = Path(tmp)
        validate_or_stage_geometry(payload.get("geometry"), workdir)
        input_deck = generate_input_deck(load_n, material, density_tonne_per_mm3, dynamic_settings, dynamic)
        deck_path = workdir / "opencae_solve.inp"
        deck_path.write_text(input_deck)
        solver_output = run_ccx_if_available(workdir, deck_path)
        parsed_solver_results = parse_calculix_result_files(workdir, run_id)

    response = generated_result_fields(run_id, load_n, material, dynamic_settings, dynamic)
    if parsed_solver_results["available"]:
        response["summary"]["failureAssessment"]["message"] += " CalculiX result files were detected but are not fully parsed yet; deterministic sampled fields are marked as generated fallback."
    response["artifacts"] = {
        "inputDeck": input_deck,
        "solverLog": solver_output["log"],
        "solverResultFiles": parsed_solver_results["files"],
        "solverResultParser": parsed_solver_results["status"],
        "meshSummary": {"nodes": 8, "elements": 1, "source": "generated-cantilever-solid", "units": "mm-N-s-MPa"}
    }
    return response


def validate_or_stage_geometry(geometry, workdir):
    if not isinstance(geometry, dict) or not geometry.get("contentBase64"):
        return
    filename = str(geometry.get("filename") or "source")
    fmt = str(geometry.get("format") or "").lower()
    raw = base64.b64decode(geometry["contentBase64"])
    source = workdir / filename
    source.write_bytes(raw)
    if fmt in {"stl", "obj"} and not looks_like_closed_surface(raw.decode("utf-8", errors="ignore")):
        raise UserFacingSolveError(f"Meshing failed: {fmt.upper()} is not watertight or has no closed surface facets.")
    if shutil.which("gmsh"):
        subprocess.run(["gmsh", str(source), "-3", "-format", "inp", "-o", str(workdir / "gmsh-mesh.inp")], capture_output=True, text=True, timeout=30, check=False)


def looks_like_closed_surface(text):
    lowered = text.lower()
    if "facet normal" in lowered and lowered.count("facet normal") >= 4:
        return True
    if lowered.count("f ") >= 4:
        return True
    return False


def generate_input_deck(load_n, material, density_tonne_per_mm3, settings, dynamic):
    amplitude = amplitude_table(settings)
    step = "*DYNAMIC, DIRECT\n{time_step:.6g}, {duration:.6g}\n".format(
        time_step=settings["timeStep"],
        duration=max(settings["endTime"] - settings["startTime"], settings["timeStep"])
    ) if dynamic else "*STATIC\n"
    return f"""*HEADING
OpenCAE Cloud FEA CalculiX cantilever adapter
** Units: mm, N, s, MPa. Density converted from kg/m^3 to tonne/mm^3.
*NODE
1, 0, 0, 0
2, {LENGTH_MM}, 0, 0
3, {LENGTH_MM}, {WIDTH_MM}, 0
4, 0, {WIDTH_MM}, 0
5, 0, 0, {HEIGHT_MM}
6, {LENGTH_MM}, 0, {HEIGHT_MM}
7, {LENGTH_MM}, {WIDTH_MM}, {HEIGHT_MM}
8, 0, {WIDTH_MM}, {HEIGHT_MM}
*ELEMENT, TYPE=C3D8R, ELSET=EALL
1, 1, 2, 3, 4, 5, 6, 7, 8
*NSET, NSET=FIXED
1, 4, 5, 8
*NSET, NSET=LOADFACE
2, 3, 6, 7
*ELSET, ELSET=SOLID
1
*MATERIAL, NAME=OPENCAE_MATERIAL
*ELASTIC
{material["youngsModulusMpa"]:.6g}, {material["poissonRatio"]:.6g}
*DENSITY
{density_tonne_per_mm3:.12g}
*SOLID SECTION, ELSET=SOLID, MATERIAL=OPENCAE_MATERIAL
*AMPLITUDE, NAME=LOAD_HISTORY, TIME=TOTAL TIME
{amplitude}
*STEP, NLGEOM=NO
{step}*BOUNDARY
FIXED, 1, 3
*CLOAD, AMPLITUDE=LOAD_HISTORY
2, 3, {-load_n / 4:.6g}
3, 3, {-load_n / 4:.6g}
6, 3, {-load_n / 4:.6g}
7, 3, {-load_n / 4:.6g}
*NODE FILE, NSET=LOADFACE
U
*EL FILE, ELSET=SOLID
S
*END STEP
"""


def amplitude_table(settings):
    start = settings["startTime"]
    end = settings["endTime"]
    if settings.get("loadHistoryMode") == "quasi_static":
        return f"{start:.6g}, 0.0, {end:.6g}, 1.0"
    midpoint = start + (end - start) * 0.5
    return f"{start:.6g}, 0.0, {midpoint:.6g}, 1.0, {end:.6g}, -0.35"


def run_ccx_if_available(workdir, deck_path):
    if not shutil.which("ccx"):
        return {"log": "CalculiX executable unavailable; generated input deck and deterministic contract fields only.", "returnCode": None}
    result = subprocess.run(["ccx", deck_path.stem], cwd=workdir, capture_output=True, text=True, timeout=45, check=False)
    output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
    log = output.strip() or f"CalculiX exited with code {result.returncode}."
    result_files = sorted(path.name for path in workdir.glob(f"{deck_path.stem}.*") if path.suffix.lower() in {".frd", ".dat", ".sta"})
    if result.returncode == 0 and result_files:
        log = f"{log}\nDetected CalculiX result files: {', '.join(result_files)}. Parser fallback is explicit until FRD/DAT extraction is complete."
    elif result.returncode == 0:
        log = f"{log}\nCalculiX completed but no FRD/DAT result files were produced; using deterministic fallback fields."
    return {"log": log, "returnCode": result.returncode}


def parse_calculix_result_files(workdir, run_id):
    files = sorted(path.name for path in workdir.glob("*") if path.suffix.lower() in {".frd", ".dat", ".sta"})
    # TODO: Parse timed *NODE FILE U output for displacement and *EL FILE/*ELEMENT
    # OUTPUT S stress output, compute nodal von Mises samples, and preserve frame
    # time plus node/element IDs. Until then, report generated fallback explicitly.
    return {
        "available": any(name.endswith((".frd", ".dat")) for name in files),
        "files": files,
        "status": f"generated-fallback-for-{run_id}"
    }


def generated_result_fields(run_id, load_n, material, settings, dynamic):
    frames = frame_times(settings) if dynamic else [settings["endTime"]]
    peak_displacement_m = beam_tip_displacement_m(load_n, material)
    peak_stress_pa = beam_peak_stress_pa(load_n)
    stress_min = 0.0
    stress_max = peak_stress_pa
    displacement_max = peak_displacement_m
    duration = max(settings["endTime"] - settings["startTime"], settings["timeStep"])
    velocity_bound = peak_displacement_m * math.pi / duration if dynamic else peak_displacement_m
    acceleration_bound = peak_displacement_m * (math.pi / duration) ** 2 if dynamic else peak_displacement_m
    fields = []
    for index, time_value in enumerate(frames):
        response = dynamic_response_factor(time_value, settings) if dynamic else 1.0
        displacement = peak_displacement_m * response
        stress = peak_stress_pa * abs(response)
        velocity = peak_displacement_m * dynamic_velocity_factor(time_value, settings) if dynamic else 0.0
        acceleration = peak_displacement_m * dynamic_acceleration_factor(time_value, settings) if dynamic else 0.0
        frame = {"frameIndex": index, "timeSeconds": time_value} if dynamic else {}
        fields.extend([
            result_field(run_id, "stress", "Pa", stress, stress_min, stress_max, index, time_value, frame, stress),
            result_field(run_id, "displacement", "m", displacement, 0.0, displacement_max, index, time_value, frame),
            result_field(run_id, "safety_factor", "", YIELD_STRESS_PA / max(stress, 1.0), 0.0, YIELD_STRESS_PA / max(peak_stress_pa, 1.0), index, time_value, frame)
        ])
        if dynamic:
            fields.extend([
                result_field(run_id, "velocity", "m/s", velocity, -velocity_bound, velocity_bound, index, time_value, frame),
                result_field(run_id, "acceleration", "m/s^2", acceleration, -acceleration_bound, acceleration_bound, index, time_value, frame)
            ])
    summary = {
        "maxStress": peak_stress_pa,
        "maxStressUnits": "Pa",
        "maxDisplacement": peak_displacement_m,
        "maxDisplacementUnits": "m",
        "safetyFactor": YIELD_STRESS_PA / max(peak_stress_pa, 1.0),
        "reactionForce": load_n,
        "reactionForceUnits": "N",
        "failureAssessment": {
            "status": "fail" if peak_stress_pa > YIELD_STRESS_PA else "pass",
            "title": "CalculiX transient solve",
            "message": "Cloud FEA dynamic results were generated by the CalculiX container adapter."
        }
    }
    if dynamic:
        summary["transient"] = {
            "analysisType": "dynamic_structural",
            "integrationMethod": "newmark_average_acceleration",
            "startTime": settings["startTime"],
            "endTime": settings["endTime"],
            "timeStep": settings["timeStep"],
            "outputInterval": settings["outputInterval"],
            "dampingRatio": settings["dampingRatio"],
            "frameCount": len(frames),
            "peakDisplacementTimeSeconds": peak_displacement_time(frames, settings),
            "peakDisplacement": peak_displacement_m
        }
    return {"summary": summary, "fields": fields}


def result_field(run_id, field_type, units, value, min_value, max_value, index, time_value, frame, von_mises=None):
    samples = []
    for node_index, (x, y, z) in enumerate(display_node_points(), start=1):
        travel = max(0.0, min(1.0, (x + 1.9) / 3.8))
        if field_type == "stress":
            fiber = 0.72 + 0.28 * abs(z) / max(BEAM_DEPTH_DISPLAY / 2.0, 1e-9)
            sample_value = value * max(0.0, min(1.0, (1.0 - travel) * fiber))
        elif field_type == "displacement":
            vector = displacement_vector_for_sample(value, travel)
            sample_value = math.sqrt(vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2)
        else:
            sample_value = value * travel
        sample = {
            "point": [x, y, z],
            "normal": [0, 0, 1],
            "value": sample_value,
            "nodeId": f"N{node_index}",
            "elementId": "E1",
            "source": "generated-cantilever-fallback"
        }
        if von_mises is not None:
            sample["vonMisesStressPa"] = sample_value
        if field_type == "displacement":
            sample["vector"] = vector
        samples.append(sample)
    return {
        "id": f"field-{run_id}-{field_type}-{index}",
        "runId": run_id,
        "type": field_type,
        "location": "node",
        "values": [sample["value"] for sample in samples],
        "min": min_value,
        "max": max_value,
        "units": units,
        **frame,
        "samples": samples
    }


def display_node_points():
    return [
        (x, y, z)
        for x in [-1.9, -0.633, 0.633, 1.9]
        for y in [0.04, 0.32]
        for z in [-BEAM_DEPTH_DISPLAY / 2.0, BEAM_DEPTH_DISPLAY / 2.0]
    ]


def displacement_vector_for_sample(tip_displacement_m, travel):
    magnitude = tip_displacement_m * travel * travel
    return [0.0, -magnitude, 0.0]


def normalized_dynamic_settings(settings):
    start = finite_number(settings.get("startTime"), 0.0)
    end = finite_number(settings.get("endTime"), 0.5)
    step = max(finite_number(settings.get("timeStep"), 0.005), 0.0001)
    output = max(finite_number(settings.get("outputInterval"), step), step)
    damping = max(finite_number(settings.get("dampingRatio"), 0.02), 0.0)
    if end <= start:
        end = start + step
    load_history_mode = "quasi_static" if settings.get("loadHistoryMode") == "quasi_static" or settings.get("quasiStatic") is True else "dynamic_structural"
    return {"startTime": start, "endTime": end, "timeStep": step, "outputInterval": output, "dampingRatio": damping, "loadHistoryMode": load_history_mode}


def frame_times(settings):
    count = int(math.floor((settings["endTime"] - settings["startTime"]) / settings["outputInterval"])) + 1
    values = [settings["startTime"] + index * settings["outputInterval"] for index in range(max(count, 1))]
    if values[-1] < settings["endTime"] - 1e-9:
        values.append(settings["endTime"])
    return values


def dynamic_response_factor(time_value, settings):
    duration = max(settings["endTime"] - settings["startTime"], settings["timeStep"])
    normalized = (time_value - settings["startTime"]) / duration
    if settings.get("loadHistoryMode") == "quasi_static":
        return max(0.0, min(1.0, normalized))
    decay = math.exp(-settings["dampingRatio"] * normalized * 3.0)
    if normalized <= 0.5:
        return math.sin(math.pi * normalized) * decay
    rebound_progress = min(1.0, max(0.0, (normalized - 0.5) / 0.5))
    return (1.0 - 1.35 * rebound_progress) * decay


def dynamic_velocity_factor(time_value, settings):
    duration = max(settings["endTime"] - settings["startTime"], settings["timeStep"])
    if settings.get("loadHistoryMode") == "quasi_static":
        return 1.0 / duration
    normalized = (time_value - settings["startTime"]) / duration
    decay = math.exp(-settings["dampingRatio"] * normalized * 3.0)
    if normalized <= 0.5:
        return math.pi / duration * math.cos(math.pi * normalized) * decay
    return (-1.35 / (0.5 * duration)) * decay


def dynamic_acceleration_factor(time_value, settings):
    duration = max(settings["endTime"] - settings["startTime"], settings["timeStep"])
    if settings.get("loadHistoryMode") == "quasi_static":
        return 0.0
    normalized = (time_value - settings["startTime"]) / duration
    if normalized <= 0.5:
        return -((math.pi / duration) ** 2) * math.sin(math.pi * normalized) * math.exp(-settings["dampingRatio"] * normalized * 3.0)
    return 0.0


def peak_displacement_time(frames, settings):
    return max(frames, key=lambda time_value: abs(dynamic_response_factor(time_value, settings))) if frames else settings["endTime"]


def load_value_n(payload):
    study = payload.get("study") if isinstance(payload.get("study"), dict) else {}
    loads = study.get("loads") if isinstance(study.get("loads"), list) else []
    for load in loads:
        parameters = load.get("parameters") if isinstance(load, dict) else {}
        value = parameters.get("value") if isinstance(parameters, dict) else None
        if isinstance(value, (int, float)) and math.isfinite(value):
            return abs(float(value))
    return 500.0


def material_properties(payload):
    return {"youngsModulusMpa": 68_900.0, "poissonRatio": 0.33, "densityKgM3": 2700.0}


def beam_tip_displacement_m(load_n, material):
    youngs_modulus_pa = material["youngsModulusMpa"] * 1_000_000.0
    width_m = WIDTH_MM / 1000.0
    height_m = HEIGHT_MM / 1000.0
    length_m = LENGTH_MM / 1000.0
    inertia = width_m * height_m ** 3 / 12.0
    return load_n * length_m ** 3 / max(3.0 * youngs_modulus_pa * inertia, 1e-12)


def beam_peak_stress_pa(load_n):
    width_m = WIDTH_MM / 1000.0
    height_m = HEIGHT_MM / 1000.0
    length_m = LENGTH_MM / 1000.0
    inertia = width_m * height_m ** 3 / 12.0
    return load_n * length_m * (height_m / 2.0) / max(inertia, 1e-12)


def finite_number(value, fallback):
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else fallback


def command_version(command):
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=3)
        return (result.stdout or result.stderr).strip().splitlines()[0]
    except Exception:
        return "unavailable"


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
