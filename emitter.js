class EventEmitter {
  constructor() {
    this.listeners = new Map()
  }
  /**
   * Subscribes listener to specified event.
   * @return Function that unsubscribe listener from the specified event
   * @example
   * function() {
   *   const unsubscribe = events.on("connected", () => {
   *     console.log("event connected received")
   *   })
   *   unsubscribe() // listener for connected won't be called anymore
   * }
   */
  on(event, listener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    const found = this.listeners.get(event)
    if (found) {
      found.add(listener)
    }
    return () => {
      const exists = this.listeners.get(event)
      if (exists) {
        exists.delete(listener)
      }
    }
  }
  /**
   * Subscribes to event, and when it received immediately unsubscribe.
   * Unsubscribe function can be called at any time.
   * @example
   * const unsubscribe = events.once("newMessage", (message) => {
   *   console.log(message)
   * })
   * setTimeout(() => unsubscribe(), 300) // unsubscribe from event after 300 ms
   */
  once(event, listener) {
    const unsubscribe = this.on(event, (value) => {
      listener(value)
      unsubscribe()
    })
    return unsubscribe
  }
  /**
   * Creates promise that resolves when specified event is received.
   * @returns Promise resolved with payload of the event
   * @example
   * async function() {
   *   const message = await events.take("messageReceived")
   * }
   */
  take(event) {
    const { promise, resolve } = createDeferred()
    this.once(event, resolve)
    return promise
  }
  /**
   * Creates a promise that resolves when specified event is received.
   * Promise is rejected when timeout is reached.
   * @param timeout milliseconds
   * @returns Promise resolves with payload of the received event.
   * @example
   * async function() {
   *   try {
   *     const message = await events.takeTimeout("messageReceived", 300);
   *   } catch () {
   *     console.log("Timeout reached.");
   *   }
   * }
   */
  takeTimeout(event, timeout) {
    const { promise, resolve, reject } = createDeferred()
    const id = setTimeout(() => {
      unsubscribe()
      reject(undefined)
    }, timeout)
    const unsubscribe = this.once(event, (value) => {
      clearTimeout(id)
      resolve(value)
    })
    return promise
  }
  /**
   * Creates promise that resolves when left event is received with payload of the event.
   * Promise rejects when right event is received with payload of the event.
   * @example
   * async function() {
   *   try {
   *     const auth = await events.takeEither("authSuccess", "authFailure");
   *   } catch (authError) {
   *     console.error(authError);
   *   }
   * }
   */
  takeEither(success, failure) {
    return new Promise((resolve, reject) => {
      const unsubscribeSuccess = this.once(success, (result) => {
        unsubscribeFailure()
        resolve(result)
      })
      const unsubscribeFailure = this.once(failure, (error) => {
        unsubscribeSuccess()
        reject(error)
      })
    })
  }
  /**
   * Emit all listeners with payload.
   * @value Payload for event that passed to all listeners
   */
  emit(event, value) {
    const listeners = this.listeners.get(event)
    if (listeners) {
      listeners.forEach((fn) => fn(value))
    }
  }
  emitCallback(event) {
    return (value) => this.emit(event, value)
  }
  /**
   * Removes all listeners for the given event.
   * @example
   * async function() {
   *   const promise = events.take("notificationReceived")
   *   events.off("notificationReceived")
   *   await promise // promise never resolves
   * }
   */
  off(event) {
    this.listeners.delete(event)
  }
}
function createDeferred() {
  let resolve = () => {}
  let reject = () => {}
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { resolve, reject, promise }
}

module.exports = { EventEmitter }
