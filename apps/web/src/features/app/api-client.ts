export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiUrl}/v1${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...options.headers },
    ...options
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { title?: string } | null;
    throw new ApiError(
      problem?.title ?? "Something went wrong. Please try again.",
      response.status
    );
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}
