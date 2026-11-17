# REST API + MySQL + Performance Testing Framework

A self-contained sample REST API and automated test framework for product CRUD. The API runs on Express, stores records in MySQL, is tested with Playwright APIRequestContext and direct SQL assertions, includes an importable Postman collection, and has a JMeter load-test plan. Docker Compose starts the API and MySQL together; GitHub Actions runs the API/SQL suite on pushes and pull requests.

> This is a learning/demo environment. The tokens and database passwords shown here are local-only examples. Do not reuse them in a deployed or public service.

## Stack and responsibilities

| Tool | Role in this repo |
|---|---|
| Node.js + Express | Demo REST API implementation |
| MySQL 8.4 + mysql2 | Persistent product data and prepared SQL statements |
| Playwright Test APIRequestContext | Automated positive, negative, boundary, auth, CRUD, and SQL consistency checks |
| Postman | Manual / Collection Runner API scenarios |
| Apache JMeter | Repeatable low-volume HTTP load smoke plan |
| Docker Compose | Local API + MySQL environment |
| GitHub Actions | CI execution and report artifact upload |
| Helmet | Common HTTP security headers |

## Requirements

- Docker Desktop with Compose v2
- Node.js 20 or newer and npm
- Optional: Postman Desktop/Web for collection runs
- Optional: Java 17+ and Apache JMeter 5.6.3+ for the JMeter plan

## Run the whole project locally (PowerShell)

From this project directory:

```powershell
Copy-Item .env.example .env
# Optional: edit .env and replace the sample tokens/passwords for your local setup.
docker compose up -d --build --wait
npm ci
npm test
```

Check the API:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Expected response: `status = ok`, `database = connected`.

Stop the app and database while preserving the local database volume:

```powershell
docker compose down
```

Reset the disposable demo database and remove its volume:

```powershell
docker compose down -v
```

`down -v` deletes the local MySQL volume and all demo rows. Use it only when you intend to reset this demo data.

## Run API tests and reports

```powershell
npm test
npm run test:api
npm run report
```

The suite uses the configured `BASE_URL` and SQL connection in `.env`. It sends HTTP requests to the running API at port 3000 and connects to the mapped MySQL port 3307 for direct read-after-write assertions. Tests create uniquely named products and remove their records after each test.

## Authentication and local tokens

The API uses two static **demo bearer tokens** supplied through environment variables:

- `ADMIN_API_TOKEN`: read and write access
- `READONLY_API_TOKEN`: read access only

The checked-in `.env.example` contains obvious local-only values to make first run easy. The API compares the presented bearer token to these configured values. This is not a production identity system: it has no user store, token expiry, rotation, OAuth/JWT flow, or per-user audit trail. Production credentials belong in a secrets manager / CI secrets and need a proper identity provider.

## REST contract

Base URL: `http://localhost:3000`

All `/api/products` routes require `Authorization: Bearer <token>` and `Accept: application/json`. Write routes require the admin token. Health is unauthenticated.

| Method | Route | Role | Success | Purpose |
|---|---|---|---|---|
| GET | `/health` | Public | 200 | API + MySQL readiness |
| GET | `/api/products?limit=20&offset=0&search=` | Read | 200 | Paged list and optional name/SKU search |
| GET | `/api/products/:id` | Read | 200 | Fetch one product |
| POST | `/api/products` | Admin | 201 | Create product |
| PUT | `/api/products/:id` | Admin | 200 | Replace editable product fields |
| DELETE | `/api/products/:id` | Admin | 204 | Delete product |

Example request:

```http
POST /api/products HTTP/1.1
Host: localhost:3000
Authorization: Bearer local-admin-token-change-me
Content-Type: application/json

{"sku":"DEMO-001","name":"Demo backpack","description":"Sample item","price":39.99,"stock":12}
```

Validation rules: SKU is 2–40 uppercase letters, digits, or hyphens; name is 2–120 characters; description is at most 1000 characters; price is a finite number from 0 through 99,999,999.99 with at most two decimals; stock is a non-negative 32-bit integer. SKU is unique.

Error format:

```json
{"error":{"code":"VALIDATION_ERROR","message":"Product data is invalid.","details":["..."]}}
```

Common statuses: 400 invalid input, 401 missing/invalid token, 403 valid read-only token used for a write, 404 missing route/record, 409 duplicate SKU, 500 unexpected server error (message intentionally generic).

## MySQL schema and consistency checks

`src/sql/schema.sql` defines `products`: auto-increment ID, unique SKU, name, description, `DECIMAL(10,2)` price, unsigned stock, timestamps, and name/SKU indexes. MySQL creates the table when the API container starts.

SQL calls in `src/app.js` use `pool.execute()` placeholders for values, including search strings and route IDs. This helps prevent input from becoming executable SQL. The API tests query MySQL directly after POST/PUT/DELETE to compare API behavior to persisted state. SQL is test-only verification: the service never returns raw query errors to clients.

## Test coverage

`tests/api.spec.js` includes:

- Health/readiness and database connectivity.
- Missing-token 401 and read-only write 403.
- Invalid fields, numeric boundary values (`price = 0`, `stock = 0`).
- Product create/read/update/delete workflow.
- SQL checks after create/update/delete.
- Duplicate-SKU conflict and database uniqueness.
- Pagination, search, and SQL-injection-like search input.
- Invalid IDs and pagination bounds.
- Read-only token denied for PUT/DELETE.

The Playwright fixture `productFactory` generates unique product data per test and cleans up created rows after the test. Playwright API tests don't launch browsers, so `npm ci` is enough; `npx playwright install` is not needed for this API-only suite.

## Postman collection

Import `postman/api-collection.json` into Postman. Collection variables include `baseUrl`, `adminToken`, and `readToken`. Run the requests in order with Collection Runner: health → auth checks → create → duplicate → get → update → invalid payload → delete → verify deleted record. The create request generates a unique SKU and stores the created ID for later requests.

Postman verifies the HTTP contract. Direct SQL consistency checks are in the Playwright suite because Postman alone does not connect to MySQL here.

## Apache JMeter

`performance/api-load-test.jmx` is a small smoke/load profile: 20 virtual users, 10-second ramp-up, 5 iterations, health + product-list samplers, HTTP 200 assertions, and a 2.5-second per-sample duration assertion. It is for a local demo baseline, not a capacity claim or production benchmark.

With the API running, and JMeter on `PATH`:

```powershell
New-Item -ItemType Directory -Force performance\results | Out-Null
jmeter -n -t performance\api-load-test.jmx -l performance\results\api.jtl -e -o performance\results\html -Jtarget_host=127.0.0.1 -Jtarget_port=3000 -Jadmin_token=$env:ADMIN_API_TOKEN
```

Use a fresh/empty `performance\results\html` directory for each HTML report run. To open the plan in JMeter GUI: `jmeter -t performance\api-load-test.jmx`.

Run load tests only against systems you own or have explicit permission to test. Increase virtual users/ramp-up gradually and compare latency percentiles, throughput, errors, and server/DB resource use. A single local run is not a performance SLA.

## Docker and CI flow

- `compose.yaml` starts MySQL and the API. The API waits until MySQL is healthy; both services expose health checks.
- `Dockerfile` installs the locked production dependencies and starts `src/server.js`.
- `.github/workflows/api-tests.yml` starts Compose on GitHub-hosted Ubuntu, installs Node test dependencies, runs the Playwright API+SQL suite, uploads HTML/trace artifacts even after failures, then removes the ephemeral CI database volume.
- JMeter is provided as a manually run test plan; the CI workflow does not run load against a shared/public target.

## Environment variables

See `.env.example`: API port, MySQL host/port/database/user/password, root password, admin/read-only tokens, and API base URL. For Compose, the API container connects to service hostname `mysql:3306`; host-side test code connects to `127.0.0.1:3307`.

## Project map

```text
src/app.js                       Express routes, validation, auth, SQL, error mapping
src/server.js                    dotenv, DB init, HTTP lifecycle
src/db.js                        mysql2 pool and schema initialization
src/sql/schema.sql               Products table and constraints
 tests/api.spec.js                Playwright API tests + SQL assertions
playwright.config.js             API test runner, base URL, retries, report
postman/api-collection.json      Importable Postman collection
performance/api-load-test.jmx    JMeter smoke/load test plan
Dockerfile                       API container build
compose.yaml                     Local MySQL + API services
.github/workflows/api-tests.yml  CI workflow
```

## Scope / limitations

This repository demonstrates an API and its test framework together. It is not an existing company API. Static local bearer tokens are intentionally simple training auth; there is no JWT/OAuth, refresh, user/role database, rate-limit policy, inventory/order domain, payment flow, or schema migration tool. Table creation is idempotent for the demo; schema evolution should use versioned migrations. JMeter's profile is intentionally small and only a smoke baseline. Do not describe the results as production capacity unless a measured test was run with a documented environment and workload.

## Interview guide

See [docs/INTERVIEW_GUIDE_HI.md](docs/INTERVIEW_GUIDE_HI.md) for a project pitch, file walkthrough, database/API flow, and likely interview questions.

## Upload as a separate GitHub repository

Create a new empty repository, then from this folder run git init -b main, git add ., git commit -m 'Add REST API MySQL testing framework', git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git, and git push -u origin main.

