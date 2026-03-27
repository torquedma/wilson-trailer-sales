export async function handler() {
  return {
    statusCode: 200,
    body: JSON.stringify([
      {
        id: 1,
        title: "Wilson Hopper Trailer",
        price: 34000,
        description: "43' Hopper Bottom"
      }
    ])
  }
}
