var level = require('level-hyper');
var net = require('net');
var rs = require('./index');
var rmrf = require('rimraf');
var tap = require('tap');
var test = tap.test;


function createOpts() {
  var ports = [].slice.call(arguments);
  var thisport = ports.shift();
  var peers = ports.map(function(port) {
    return { host: 'localhost', port: port };
  });
  return { peers: peers, port: thisport, host: 'localhost' };
};


function createData(prefix, size) {
  //
  // generate some dummy data and sort it the way leveldb would.
  //
  var arr = Array.apply(null, new Array(size));

  return arr.map(function() { 
    return {
      key: prefix + Math.random().toString(15).slice(-256),
      value: Math.random().toString(15)
    };
  }).sort(function (a, b) {
    if (a.key > b.key) {
      return 1;
    }
    if (a.key < b.key) {
      return -1;
    }
    return 0;
  });
}


test('more than two peers', function(t) {

  var db1, db2, db3, db4;
  var r1, r2, r3, r4;
  var server1, server2, server3, server4;


  //
  // create three databases and start them.
  //
  test('setup', function(t) {

    rmrf.sync('./db1');
    rmrf.sync('./db2');
    rmrf.sync('./db3');
    rmrf.sync('./db4');
    db1 = level('./db1', { valueEncoding: 'json' });
    db2 = level('./db2', { valueEncoding: 'json' });
    db3 = level('./db3', { valueEncoding: 'json' });
    db4 = level('./db4', { valueEncoding: 'json' });

    //
    // create server 1.
    //
    r1 = rs.createServer(db1, createOpts(3000, 3001, 3002));
    server1 = net.createServer(function(con) {
      con.pipe(r1).pipe(con);
    });

    server1.listen(3000);

    //
    // create server 2 with one accidentally duplicate peer.
    //
    r2 = rs.createServer(db2, createOpts(3001, 3000, 3002));
    server2 = net.createServer(function(con) {
      con.pipe(r2).pipe(con);
    });

    server2.listen(3001);

    //
    // create server 3 by adding the peers ad-hoc.
    //
    r3 = rs.createServer(db3, createOpts(3002, 3001, 3002));
    server3 = net.createServer(function(con) {
      con.pipe(r3).pipe(con);
    });

    server3.listen(3002);

    setTimeout(function() {
      t.end();
    }, 2000)
  });


  test('that a random number of records put to one peer are replicated to all other peers', function(t) {

    var records = createData('A_', Math.floor(Math.random()*100));

    records.forEach(function(record, index) {

      db1.put(record.key, record.value, function(err) {
        t.ok(!err);

        //
        // after the last record is put, all records should be in the database.
        //
        if (index == records.length - 1) {
          [db2, db3].forEach(verifyRecords);
        }
      });
    });

    function verifyRecords(db, index) {

      var results = [];
      var count = 0;

      db.createReadStream({ gte: 'A_', lte: 'A_~' })
        .on('data', function(r) {
          ++count;
          results.push(r);
        })
        .on('end', function() {
          t.equal(count, records.length)
          t.equal(
            JSON.stringify(results), JSON.stringify(records)
          );
          if (index == 1) return t.end(); 
        });
    }
  });


  test('that records batched to one peer are replicated to all other peers', function(t) {

    function chunk(arr, n) {
      return !arr.length ? [] : [arr.slice(0, n)].concat(chunk(arr.slice(n), n));
    };

    //
    // do 5000 puts.
    //
    var size = 1000;
    var records = createData('B_', size);
    var groups = chunk(records, 2);

    groups.forEach(function(group, index) {
      var newgroup = [];
      group.forEach(function(op) {
        newgroup.push({ type: 'put', key: op.key, value: op.value });
      });

      db1.batch(newgroup, function(err) {
        t.ok(!err);
        if (index == groups.length-1) {
          [db2, db3].forEach(verifyRecords);
        }
      });
    });

    function verifyRecords(db, index) {

      var results = [];
      db.createReadStream({ gte: 'B_', lte: 'B_~' })
        .on('data', function(r) {
          results.push(r);
        })
        .on('end', function() {
          t.equal(
            JSON.stringify(results), JSON.stringify(records)
          );
          if (index == 1) return t.end(); 
        });
    }
  });

/*
  test('replicating with servers that can never be reached', function(t) {

    //
    // create server 3 by adding the peers ad-hoc.
    //
    r4 = rs.createServer(db4, createOpts(3004, 3999, 3998));
    server4 = net.createServer(function(con) {
      con.pipe(r4).pipe(con);
    });

    server4.listen(3004);

    //
    // fail when quorum can't be reached?
    //
    db4.put('test1key', 'test1value', function(err) {
      t.equal(err.message, 'Connection failed to localhost:3999', 'Callback should get an error');
      server4.close();
      db4.close();
      t.end();
    });
  });
*/

  test('that a single record is added to all peers before returning the callback', function(t) {
    
    db1.put('test1key', 'test1value', function(err) {
      t.ok(!err, 'key added to the coordinator and all other peers');
      db2.get('test1key', function(err) {
        t.ok(!err, 'key was found in db2');
        db2.get('test1key', function(err) {
          t.ok(!err, 'key was found in db3');
          t.end();
        });
      });
    });
  });



  test('that a record can be deleted from one database and it is removed from all others', function(t) {
    
    db1.del('test1key', function(err) {
      t.ok(!err, 'key added to the coordinator and all other peers');
      db2.get('test1key', function(err) {
        t.ok(err, 'key was not found in db2');
        db2.get('test1key', function(err) {
          t.ok(err, 'key was not found in db3');
          t.end();
        });
      });
    });
  });


  test('teardown', function(t) {
    server1.close();
    server2.close();
    server3.close();
    db1.close();
    db2.close();
    db3.close();
    t.end();
  });

  t.end();
});

