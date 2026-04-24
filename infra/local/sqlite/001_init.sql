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
