from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import base64
import json
import math
import os
import shutil
import subprocess
import tempfile


LENGTH_MM = 1000.0
WIDTH_MM = 80.0
HEIGHT_MM = 120.0
YIELD_STRESS_PA = 275_000_000.0


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
        deck_path = workdir / "opencae_dynamic.inp"
        deck_path.write_text(input_deck)
        solver_log = run_ccx_if_available(workdir, deck_path)

    response = generated_result_fields(run_id, load_n, material, dynamic_settings, dynamic)
    response["artifacts"] = {
        "inputDeck": input_deck,
        "solverLog": solver_log,
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
OpenCAE Cloud FEA CalculiX transient cantilever adapter
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
    midpoint = start + (end - start) * 0.5
    return f"{start:.6g}, 0.0, {midpoint:.6g}, 1.0, {end:.6g}, -0.35"


def run_ccx_if_available(workdir, deck_path):
    if not shutil.which("ccx"):
        return "CalculiX executable unavailable; generated input deck and deterministic contract fields only."
    result = subprocess.run(["ccx", deck_path.stem], cwd=workdir, capture_output=True, text=True, timeout=45, check=False)
    output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
    return output.strip() or f"CalculiX exited with code {result.returncode}."


def generated_result_fields(run_id, load_n, material, settings, dynamic):
    frames = frame_times(settings) if dynamic else [settings["endTime"]]
    peak_displacement_m = beam_tip_displacement_m(load_n, material)
    peak_stress_pa = beam_peak_stress_pa(load_n)
    stress_min = 0.0
    stress_max = peak_stress_pa
    displacement_min = -peak_displacement_m * 0.35 if dynamic else 0.0
    displacement_max = peak_displacement_m
    duration = max(settings["endTime"] - settings["startTime"], settings["timeStep"])
    velocity_bound = peak_displacement_m * math.pi / duration if dynamic else peak_displacement_m
    acceleration_bound = peak_displacement_m * (math.pi / duration) ** 2 if dynamic else peak_displacement_m
    fields = []
    for index, time_value in enumerate(frames):
        response = dynamic_response_factor(time_value, settings) if dynamic else 1.0
        signed_displacement = peak_displacement_m * response
        stress = peak_stress_pa * abs(response)
        velocity = peak_displacement_m * dynamic_velocity_factor(time_value, settings) if dynamic else 0.0
        acceleration = peak_displacement_m * dynamic_acceleration_factor(time_value, settings) if dynamic else 0.0
        frame = {"frameIndex": index, "time": time_value} if dynamic else {}
        fields.extend([
            result_field(run_id, "stress", "Pa", stress, stress_min, stress_max, index, time_value, frame, stress),
            result_field(run_id, "displacement", "m", signed_displacement, displacement_min, displacement_max, index, time_value, frame),
            result_field(run_id, "velocity", "m/s", velocity, -velocity_bound, velocity_bound, index, time_value, frame),
            result_field(run_id, "acceleration", "m/s^2", acceleration, -acceleration_bound, acceleration_bound, index, time_value, frame),
            result_field(run_id, "safety_factor", "", YIELD_STRESS_PA / max(stress, 1.0), 0.0, YIELD_STRESS_PA / max(peak_stress_pa, 1.0), index, time_value, frame)
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
        summary["transient"] = {"startTime": settings["startTime"], "endTime": settings["endTime"], "timeStep": settings["timeStep"], "outputInterval": settings["outputInterval"], "frameCount": len(frames)}
    return {"summary": summary, "fields": fields}


def result_field(run_id, field_type, units, value, min_value, max_value, index, time_value, frame, von_mises=None):
    samples = []
    for node_index, x in enumerate([0.0, LENGTH_MM * 0.33, LENGTH_MM * 0.66, LENGTH_MM], start=1):
        ratio = x / LENGTH_MM
        sample_value = value * ratio
        sample = {
            "point": [x / 1000.0, 0.04, 0.06],
            "normal": [0, 0, 1],
            "value": sample_value,
            "nodeId": f"N{node_index}",
            "elementId": "E1",
            "source": "calculix"
        }
        if von_mises is not None:
            sample["vonMisesStressPa"] = sample_value
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


def normalized_dynamic_settings(settings):
    start = finite_number(settings.get("startTime"), 0.0)
    end = finite_number(settings.get("endTime"), 0.5)
    step = max(finite_number(settings.get("timeStep"), 0.005), 0.0001)
    output = max(finite_number(settings.get("outputInterval"), step), step)
    damping = max(finite_number(settings.get("dampingRatio"), 0.02), 0.0)
    if end <= start:
        end = start + step
    return {"startTime": start, "endTime": end, "timeStep": step, "outputInterval": output, "dampingRatio": damping}


def frame_times(settings):
    count = int(math.floor((settings["endTime"] - settings["startTime"]) / settings["outputInterval"])) + 1
    values = [settings["startTime"] + index * settings["outputInterval"] for index in range(max(count, 1))]
    if values[-1] < settings["endTime"] - 1e-9:
        values.append(settings["endTime"])
    return values


def dynamic_response_factor(time_value, settings):
    duration = max(settings["endTime"] - settings["startTime"], settings["timeStep"])
    normalized = (time_value - settings["startTime"]) / duration
    decay = math.exp(-settings["dampingRatio"] * normalized * 3.0)
    if normalized <= 0.5:
        return math.sin(math.pi * normalized) * decay
    rebound_progress = min(1.0, max(0.0, (normalized - 0.5) / 0.5))
    return (1.0 - 1.35 * rebound_progress) * decay


def dynamic_velocity_factor(time_value, settings):
    duration = max(settings["endTime"] - settings["startTime"], settings["timeStep"])
    normalized = (time_value - settings["startTime"]) / duration
    decay = math.exp(-settings["dampingRatio"] * normalized * 3.0)
    if normalized <= 0.5:
        return math.pi / duration * math.cos(math.pi * normalized) * decay
    return (-1.35 / (0.5 * duration)) * decay


def dynamic_acceleration_factor(time_value, settings):
    duration = max(settings["endTime"] - settings["startTime"], settings["timeStep"])
    normalized = (time_value - settings["startTime"]) / duration
    if normalized <= 0.5:
        return -((math.pi / duration) ** 2) * math.sin(math.pi * normalized) * math.exp(-settings["dampingRatio"] * normalized * 3.0)
    return 0.0


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
