const dataHandler = require('../[...slug]');

module.exports = async function handler(req, res) {
  const collection = req.params?.collection;
  const document = req.params?.document;
  const query = {
    ...(req.query || {}),
    slug: [collection, document]
  };

  return dataHandler({
    ...req,
    query,
    params: { ...(req.params || {}), slug: [collection, document] }
  }, res);
};
