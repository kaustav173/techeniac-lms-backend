# System Architecture

## Overview

`TechEniac-lms-backend` is an API-first Learning Management System backend service implemented as a modular monolith. It provides REST APIs consumed by a decoupled frontend application.

## Core Tech Stack

- **Runtime**: Node.js 24 LTS
- **Language**: TypeScript in strict mode
- **Module Format**: CommonJS
- **Web Framework**: Express
- **ORM & Migrations**: TypeORM
- **Database**: PostgreSQL hosted on Neon (pooled connections for API runtime; direct connections for DDL migrations)
- **Validation**: Zod for runtime environment and request validation

## Architectural Layers

- **`src/main.ts` & `src/app.ts`**: Process lifecycle, HTTP server instantiation, and middleware pipeline configuration.
- **`src/core/`**: Infrastructure and cross-cutting capabilities isolated from business domains:
  - `config/`: Validated environment variables via Zod schemas.
  - `db/`: Database connection management, TypeORM DataSource, and connection pooling.
  - `errors/`: Centralized HTTP and domain error hierarchy.
  - `http/`: Shared middleware (error handling, request logging, security headers).
  - `logging/`: Structured logger.
  - `health/`: Liveness and readiness health check endpoints.
  - `openapi/`: OpenAPI specification generation and documentation.
- **`src/modules/`**: Domain feature modules containing controllers, services, repositories, and domain entities.
- **`src/migrations/`**: Version-controlled TypeORM schema migrations executed via the direct database URL.
