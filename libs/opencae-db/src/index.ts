import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { starterMaterials } from "@opencae/materials";
import type { Material, Project, Study, StudyRun } from "@opencae/schema";
import { bracketDemoProject } from "./sampleData";

export interface DatabaseProvider {
  migrate(): void;
  seed(): void;
  listProjects(): Project[];
  getProject(projectId: string): Project | undefined;
  upsertProject(project: Project): void;
  getStudy(studyId: string): Study | undefined;
  upsertStudy(study: Study): void;
  upsertRun(run: StudyRun): void;
  getRun(runId: string): StudyRun | undefined;
  listMaterials(): Material[];
}

export class SQLiteDatabaseProvider implements DatabaseProvider {
  private readonly db: Database.Database;

  constructor(private readonly dbPath = path.resolve(process.cwd(), "data/sqlite/opencae.local.sqlite")) {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
  }

  migrate(): void {
    this.db.exec(migrationSql);
  }

  seed(): void {
    for (const material of starterMaterials) {
      this.db
        .prepare("insert into materials (id, data) values (?, ?) on conflict(id) do update set data = excluded.data")
        .run(material.id, JSON.stringify(material));
    }
    if (!this.getProject(bracketDemoProject.id)) {
      this.upsertProject(bracketDemoProject);
    }
  }

  listProjects(): Project[] {
    return this.db
      .prepare("select data from projects order by updated_at desc")
      .all()
      .map((row) => JSON.parse((row as { data: string }).data) as Project);
  }

  getProject(projectId: string): Project | undefined {
    const row = this.db.prepare("select data from projects where id = ?").get(projectId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Project) : undefined;
  }

  upsertProject(project: Project): void {
    this.persistProjectOnly(project);
    for (const study of project.studies) {
      this.persistStudyOnly(study);
    }
  }

  getStudy(studyId: string): Study | undefined {
    const row = this.db.prepare("select data from studies where id = ?").get(studyId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Study) : undefined;
  }

  upsertStudy(study: Study): void {
    this.persistStudyOnly(study);
    const project = this.getProject(study.projectId);
    if (project) {
      const studies = project.studies.filter((existing) => existing.id !== study.id).concat(study);
      this.persistProjectOnly({ ...project, studies, updatedAt: new Date().toISOString() });
    }
  }

  upsertRun(run: StudyRun): void {
    this.db
      .prepare(
        "insert into runs (id, study_id, status, data) values (?, ?, ?, ?) on conflict(id) do update set status = excluded.status, data = excluded.data"
      )
      .run(run.id, run.studyId, run.status, JSON.stringify(run));
    const study = this.getStudy(run.studyId);
    if (study) {
      const runs = study.runs.filter((existing) => existing.id !== run.id).concat(run);
      this.upsertStudy({ ...study, runs });
    }
  }

  getRun(runId: string): StudyRun | undefined {
    const row = this.db.prepare("select data from runs where id = ?").get(runId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as StudyRun) : undefined;
  }

  listMaterials(): Material[] {
    return this.db
      .prepare("select data from materials order by id")
      .all()
      .map((row) => JSON.parse((row as { data: string }).data) as Material);
  }

  private persistProjectOnly(project: Project): void {
    this.db
      .prepare(
        "insert into projects (id, name, updated_at, data) values (?, ?, ?, ?) on conflict(id) do update set name = excluded.name, updated_at = excluded.updated_at, data = excluded.data"
      )
      .run(project.id, project.name, project.updatedAt, JSON.stringify(project));
  }

  private persistStudyOnly(study: Study): void {
    this.db
      .prepare(
        "insert into studies (id, project_id, name, data) values (?, ?, ?, ?) on conflict(id) do update set project_id = excluded.project_id, name = excluded.name, data = excluded.data"
      )
      .run(study.id, study.projectId, study.name, JSON.stringify(study));
  }
}

export const migrationSql = `
create table if not exists local_users (
  id text primary key,
  name text not null
);

create table if not exists local_organizations (
  id text primary key,
  name text not null
);

create table if not exists materials (
  id text primary key,
  data text not null
);

create table if not exists projects (
  id text primary key,
  name text not null,
  updated_at text not null,
  data text not null
);

create table if not exists studies (
  id text primary key,
  project_id text not null,
  name text not null,
  data text not null
);

create table if not exists runs (
  id text primary key,
  study_id text not null,
  status text not null,
  data text not null
);

insert or ignore into local_users (id, name) values ('local-user', 'Local User');
insert or ignore into local_organizations (id, name) values ('local-org', 'Local Organization');
`;
