var mysql = require('mysql');
var async = require('async');
var pool = require('../db');
var settings = require('../settings');
var limits = require('../limits');
var lookups = require('../lookups');

module.exports.addMessage = function (parameters, cb)
{
	var min_ver = settings.value('min_version_value');
	if (min_ver)
	{
		var value = lookups.calcVersionValue(safe(parameters.version).substr(0, limits.VERSION_TITLE_LENGTH));
		// Reject older versions right away.  Just noise.
		if (value < min_ver)
			return cb(null, null);
	}

	pool.getConnection(function (err, conn)
	{
		async.auto({
			id_version: lookups.getVersionId.bind(this, conn, parameters.version),
			id_gpu: lookups.getGpuId.bind(this, conn, parameters.gpu, parameters.gpu_full),
			id_cpu: lookups.getCpuId.bind(this, conn, parameters.cpu),
			id_platform: lookups.getPlatformId.bind(this, conn, parameters.platform),
			id_game: lookups.getGameId.bind(this, conn, parameters.game, parameters.game_title),
			id_msg_kind: lookups.getMessageKindId.bind(this, conn, parameters.message),
			id_config: lookups.getConfigId.bind(this, conn, parameters),

			id_msg: [
				'id_version', 'id_gpu', 'id_cpu', 'id_platform', 'id_game', 'id_config', 'id_msg_kind',
				function (cb, args)
				{
					args.formatted_message = parameters.value;
					lookups.getMessageId(conn, args, cb);
				}
			],

			log_hits: [
				'id_msg',
				function (cb, args)
				{
					conn.query('\
						CALL report_message_hit(:id_msg, :id_version, :id_gpu, :id_cpu, :id_platform, :id_config)', args, cb);
				}
			]
		}, function (err, result)
		{
			conn.release();
			cb(err, result);
		});
	});
};

module.exports.getRecentMessageList = function (args, cb)
{
	var needsTemp = false;
	var clauses = [];

	if (args.status != undefined)
	{
		switch (args.status)
		{
		case "any":
			break;

		case "new":
		case "resolved":
		case "reoccurring":
			clauses.push("m.status IN ('" + args.status + "')");
			break;

		default:
			clauses.push("m.status IN ('new', 'reoccurring')");
		}
	}
	else
		clauses.push("m.status IN ('new', 'reoccurring')");

	if (args.id_game != undefined)
	{
		clauses.push('m.id_game = ' + mysql.escape(args.id_game));
		// Force a temp table, the index usage for this path is not great.
		// MySQL uses a temp table anyway, but not as well as we can.
		needsTemp = true;
	}
	if (args.version != undefined)
		clauses.push('v.title = ' + mysql.escape(args.version));
	if (args.id_msg_kind != undefined)
		clauses.push('m.id_msg_kind = ' + mysql.escape(args.id_msg_kind));

	var needsMaxCheck = clauses.length == 0 || (!args.status && clauses.length <= 1);
	pool.getConnection(function (err, conn)
	{
		var extraJoinSQL = '';

		var makeWhere = function ()
		{
			var where = '';
			if (clauses.length == 1)
				where = 'WHERE ' + clauses[0];
			else if (clauses.length > 1)
				where = 'WHERE ' + clauses.join(' AND ');
			return where;
		}

		var actualQuery = function (queryArgs)
		{
			conn.query('\
				SELECT \
					g.title, g.id_game, MAX(v.title) AS version, v.id_version, m.id_msg_kind, \
					m.formatted_message AS message, MAX(mv.latest_report) AS latest_report, \
					mk.message AS message_template \
				FROM report_messages AS m' + extraJoinSQL + ' \
					INNER JOIN games AS g USING (id_game) \
					INNER JOIN report_message_kinds AS mk USING (id_msg_kind) \
					INNER JOIN report_message_versions AS mv USING (id_msg) \
					INNER JOIN versions AS v USING (id_version) \
				' + makeWhere() + ' \
				GROUP BY m.id_msg DESC \
				LIMIT 100', queryArgs, function (err, result)
				{
					if (err)
						console.log(err);
					conn.release();
					cb(err, result);
				});
		};

		if (needsMaxCheck)
		{
			// TODO: Could simply cache this.
			conn.queryGrab('\
				SELECT MAX(id_msg) \
				FROM report_messages', {}, function (err, max_id_msg)
			{
				clauses.push('m.id_msg > :max_id_msg - 1000');
				return actualQuery({max_id_msg: max_id_msg});
			});
		}
		// The purpose of this is to reduce the set it's looking at for the other joins.
		else if (needsTemp)
		{
			// Gotta drop it first in case another page view left it hanging.
			conn.query('\
				DROP TEMPORARY TABLE IF EXISTS temp_messages', function (err)
				{
					if (err)
						console.log(err);
					conn.query('\
						CREATE TEMPORARY TABLE temp_messages ( \
							PRIMARY KEY (id_msg) \
						) \
						SELECT m.id_msg \
						FROM report_messages AS m \
						' + makeWhere() + ' \
						ORDER BY m.id_msg DESC \
						LIMIT 100', function (err, max_id_msg)
					{
						if (err)
							console.log(err);
						extraJoinSQL = ' \
							INNER JOIN temp_messages USING (id_msg)';
						return actualQuery({});
					});	
				});
		}
		else
			actualQuery({});
	});
};

module.exports.getKindList = function (args, cb)
{
	var clauses = [];

	if (args.status != undefined)
	{
		switch (args.status)
		{
		case "any":
			break;

		case "new":
		case "resolved":
		case "reoccurring":
			clauses.push("m.status IN ('" + args.status + "')");
			break;

		default:
			clauses.push("m.status IN ('new', 'reoccurring')");
		}
	}
	else
		clauses.push("m.status IN ('new', 'reoccurring')");


	pool.getConnection(function (err, conn)
	{
		var makeWhere = function ()
		{
			var where = '';
			if (clauses.length == 1)
				where = 'WHERE ' + clauses[0];
			else if (clauses.length > 1)
				where = 'WHERE ' + clauses.join(' AND ');
			return where;
		}

		conn.query('\
			SELECT mk.id_msg_kind, mk.message, COUNT(DISTINCT m.id_game) AS games \
			FROM report_message_kinds AS mk \
				INNER JOIN report_messages AS m USING (id_msg_kind) \
			' + makeWhere() + ' \
			GROUP BY mk.id_msg_kind DESC \
			LIMIT 1000', null, function (err, result)
			{
				if (err)
					console.log(err);
				conn.release();
				cb(err, result);
			});
	});
};

function safe(s, def)
{
	if (typeof s == 'undefined')
		return typeof def == 'undefined' ? '' : def;
	return String(s);
}