const nodeDefs = [
  require('./analysis/sentiment'),
  require('./core/comment'),
  require('./io/meshblu'),
  require('./io/gpio')
];

module.exports = function(RED){
  nodeDefs.forEach(function(n){
    n(RED);
  });
}