export class PlayerError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}
export function message(error) {
  return error instanceof PlayerError ? error.message : '本机服务或片源暂时不可达，请重试'
}
