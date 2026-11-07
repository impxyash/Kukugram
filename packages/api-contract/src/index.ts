export const apiVersion = "v1";

export interface HealthResponse {
  status: "ok";
  requestId: string;
}

export * from "./schemas.js";
