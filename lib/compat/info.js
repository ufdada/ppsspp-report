var async = require('async');
var pool = require('../db');
var settings = require('../settings');
var limits = require('../limits');
var lookups = require('../lookups');

module.exports.getGameData = function (parameters, cb)
{
	pool.getConnection(function (err, conn)
	{
		conn.queryFirst('\
			SELECT g.title, g.id_game, cmpr.title AS compat, cmpr.identifier AS compat_ident, cmp.overall_stars \
			FROM games AS g \
				LEFT JOIN compatibility AS cmp USING (id_game) \
				LEFT JOIN compat_ratings AS cmpr USING (id_compat_rating) \
			WHERE g.id_game = :id_game \
			LIMIT 5', parameters, function (err, results)
		{
			conn.release();
			cb(err, results);
		});
	});
};

module.exports.getReports = function (parameters, cb)
{
	var clauses = [
		"rcmp.id_game = :id_game",
	];

	pool.getConnection(function (err, conn)
	{
		var makeWhere = function (additional)
		{
			var where = '';
			var all = clauses.concat(additional || []);
			if (all.length == 1)
				where = 'WHERE ' + all[0];
			else if (all.length > 1)
				where = 'WHERE ' + all.join(' AND ');
			return where;
		}

		conn.query('\
			SELECT \
				cmpr.title AS compat, cmpr.identifier AS compat_ident, cpu.summary AS cpu, \
				gpu.nickname AS gpu, p.title AS platform, v.title AS version, \
				rcmp.latest_report, rcmp.graphics_stars, rcmp.speed_stars, rcmp.gameplay_stars \
			FROM report_compatibility AS rcmp \
				LEFT JOIN compat_ratings AS cmpr USING (id_compat_rating) \
				INNER JOIN cpus AS cpu USING (id_cpu) \
				INNER JOIN gpus AS gpu USING (id_gpu) \
				INNER JOIN platforms AS p USING (id_platform) \
				INNER JOIN versions AS v USING (id_version) \
			' + makeWhere() + ' \
			ORDER BY rcmp.latest_report DESC', parameters, function (err, results)
		{
			conn.release();
			cb(err, results);
		});
	});
};